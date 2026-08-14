/**
 * rls-generator — Trivial generates the RLS from a per-project access manifest. Never
 * hand-authored, never AI-authored: Trio declares INTENT (the manifest, inside its guardrail);
 * this emits the enforced policy. "Security is a used primitive, not an authored artifact."
 *
 * The SAME generateAll() output loads into PGLite (build, in the preview Service Worker) AND the
 * run-Postgres app_<projectId> schema (real) — that's the build↔run parity. Ported from an earlier
 * experiment's pgmt/{policies,rls-generator}.ts (proven byte-identical across both engines by
 * verify-parity.ts), generalized to take a per-project manifest instead of a hardcoded one.
 *
 * Keyed on the per-request identity GUCs the substrate's connection-discipline wrapper sets
 * (app.user_id / app.user_role) — never on anything the app/handler controls.
 */

/**
 * Per-field (column-level) projection rule. The closed read/write
 * enum is `all | owner | admin` — `admin` was added now that the reserved admin role is SECURED (driven
 * from the Trivial GRANT, never the self-assertable token claim — grants.ts / site-auth.ts), so an
 * `admin`-only column (a `managed` table's status/cost-basis) is trustworthy. NEVER a free-form predicate.
 * Per-field access is the ONE guarantee Postgres does NOT enforce (the shared `app_<pid>` role makes column
 * access app-layer, not a GRANT) — so it is carried as a column COMMENT the DB stays the source of truth
 * for, and applied as a STRICTLY SUBTRACTIVE projection at the runtime seam (runtime-api.ts): it only ever
 * REMOVES columns from an already-RLS-visible row, never widens a row.
 */
export type FieldAccess = 'all' | 'owner' | 'admin';
export interface FieldRule { read: FieldAccess; write: FieldAccess; }
export type FieldRules = Record<string, FieldRule>;

/** Cross-cutting per-table modifiers layered on ANY access type. */
interface Projection {
  /**
   * Optional per-column read/write projection. Absent ⇒ every column is read=all / write=all (visible +
   * writable — the older behavior). The canvas inspector / Trio AUTHORS this; Trivial COMPILES it to
   * `COMMENT ON COLUMN "<t>"."<col>" IS 'trivial:field:read=<r>;write=<w>'` markers (see generateRls).
   */
  fields?: FieldRules;
  /**
   * Optional creator-identity column, STAMPED from the `app.user_id` GUC (so it is unforgeable — a
   * forged owner in a body is overwritten by the DEFAULT), used by the per-field `owner` projection to
   * test row-ownership. `owner` access already carries an ownerColumn that doubles as this; declaring it
   * on authenticated/public/role lets those tables carry `owner` field rules WITHOUT changing their
   * row-level access — the Shape-3 model (members read ALL rows; only secret columns are owner-only).
   */
  ownerColumn?: string;
}

/** The access-declaration vocabulary (the generator's input contract). Today:
 *  `public | authenticated | owner | role | managed` — still a small, AI-selectable closed set. */
export type Access =
  | ({
      access: 'public';
      insertAnyone?: boolean;
      /** the orthogonal WRITE axis: the world reads, the declared audience writes. Absent =
       *  today's curated-public (writes denied). 'owner' requires ownerColumn — any signed-in user
       *  may CREATE (the stamp DEFAULT makes the row theirs) and edits only their own: a forum.
       *  'role' requires the role key. Valid only on public (closed combination space, ). */
      write?: 'admin' | 'owner' | 'authenticated' | 'role';
      role?: string;
      /** value-dependent row visibility, deliberately closed to ONE shape (declared column =
       *  literal). Hidden rows stay visible to write-holders + admin (draft semantics, ); NULL
       *  fails both literal forms, so an unset flag column is hidden. */
      visibleWhen?: { column: string; equals: string | boolean };
    } & Projection)  // anyone reads (optionally visibility-filtered); writes per the axis — insertAnyone still opens APPEND
  | ({ access: 'authenticated' } & Projection)                   // any signed-in end-user
  | ({ access: 'owner'; ownerColumn: string; insertAnyone?: boolean } & Omit<Projection, 'ownerColumn'>) // each end-user sees/writes only their own rows — insertAnyone = contact-form/RSVP (anon rows own NULL)
  | ({ access: 'role'; role: string } & Projection)              // end-users whose GRANTED role (grants.ts) matches
  | ({ access: 'managed'; ownerColumn: string } & Omit<Projection, 'ownerColumn'>); // owner-or-admin: each member sees/writes
                                                                 // their own rows; a GRANTED `admin` sees/writes ALL (G1, the WEDGE)

/** Per-project access declarations: table name → its access policy. */
export type AccessManifest = Record<string, Access>;

/** Defense-in-depth ident guard for column names interpolated into emitted DDL (owner stamp + COMMENTs).
 *  Mirrors index.ts's `safeIdent`; kept local so the generator stays a dependency-free shared capability. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

const UID = `current_setting('app.user_id', true)`;
const ROLE = `current_setting('app.user_role', true)`;

/**
 * Emit ENABLE/FORCE RLS + the PER-COMMAND policies for one table from its access declaration.
 *
 * The generator moved from a `<t>_read` (FOR SELECT) + `<t>_write` (FOR ALL) pair to FOUR
 * command-scoped policies: `<t>_select` (SELECT) · `<t>_insert` (INSERT) · `<t>_update` (UPDATE) ·
 * `<t>_delete` (DELETE). For the existing four access types this is a BEHAVIORAL NO-OP — the effective
 * row-security is byte-identical, because every current type has `write ⇒ read` (you can only write rows
 * you can read), so the old SELECT command's `read OR write` collapses to `read` and the FOR ALL split
 * cleanly into per-command policies carrying the same predicate. (Proof: for SELECT the old policy set
 * applied `read OR write`; the new set applies `read`; equal iff write⇒read — true for public[w=false],
 * authenticated/owner/role[w=read]. INSERT/UPDATE/DELETE carry the same write predicate in both shapes.)
 *
 * The refactor exists to make INTENT expressible that a single FOR ALL qual cannot: anon-INSERT-only
 * (`submission`: insert-anyone but read-owner-only — write⇏read) and owner-OR-admin super-write
 * (`managed`, shipped below). That refactor shipped ONLY the structural split.
 *
 * 🔒 NULLIF anon-safety: `authenticated`, `owner` and `managed`
 * guard the `app.user_id` GUC with `NULLIF(…, '')`, because a custom GUC reverts to '' (NOT NULL) on a warm
 * pooled connection ⇒ a bare comparison would let an anon read/write a shared '' bucket. So those types are
 * deliberately NO LONGER byte-identical to their pre-NULLIF form — the effective-equivalence lock now
 * holds only for `public` (true/false) and `role` (GUC-literal, '' matches nothing). The owner-column DEFAULT
 * is NULLIF-guarded for the same reason. Re-validated by the trinity + R4 + field harnesses.
 *
 * Two coupled introspectors parse this naming and move in lockstep: seed.ts's migrate `writeDenied`
 * detection (now keys on the `<t>_insert` policy's WITH CHECK = false) and index.ts's `accessFromQual`
 * (the Data-app label — derives from the `<t>_select` policy's USING; updated for the NULLIF forms + the
 * `managed` owner-or-admin qual). The DROP set covers BOTH the legacy `_read`/`_write` names AND the new
 * per-command names, so re-asserting RLS over a schema created by either generator (migrate) is idempotent.
 */
export function generateRls(table: string, p: Access): string {
  const lines = [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
    // Drop the legacy read/write pair AND the per-command names → idempotent over either generation.
    `DROP POLICY IF EXISTS ${table}_read ON ${table};`,
    `DROP POLICY IF EXISTS ${table}_write ON ${table};`,
    `DROP POLICY IF EXISTS ${table}_select ON ${table};`,
    `DROP POLICY IF EXISTS ${table}_insert ON ${table};`,
    `DROP POLICY IF EXISTS ${table}_update ON ${table};`,
    `DROP POLICY IF EXISTS ${table}_delete ON ${table};`,
  ];
  let read: string;
  let write: string;
  switch (p.access) {
    case 'public': {
      // the write axis. Predicates are the EXISTING battle-tested forms only (NULLIF
      // anon-safety, the unforgeable owner stamp, the GRANT-driven role GUC) — no new shapes.
      switch (p.write) {
        case 'admin':
          write = `${ROLE} = 'admin'`;
          break;
        case 'owner':
          if (!p.ownerColumn || !SAFE_IDENT.test(p.ownerColumn)) throw new Error(`rls-generator: write 'owner' on table ${table} requires a safe ownerColumn`);
          write = `${p.ownerColumn} = NULLIF(${UID}, '')`;
          break;
        case 'authenticated':
          write = `NULLIF(${UID}, '') IS NOT NULL`;
          break;
        case 'role':
          if (!p.role || !SAFE_IDENT.test(p.role)) throw new Error(`rls-generator: write 'role' on table ${table} requires a safe role`);
          write = `${ROLE} = '${p.role}'`;
          break;
        default:
          write = 'false';
      }
      // visibleWhen narrows SELECT. Hidden rows stay visible to write-holders + admin
      // (draft semantics — an author who cannot see their own draft is broken). The literal is
      // validated upstream (closed charset/length) and quote-escaped here; NULL fails both forms.
      if (p.visibleWhen) {
        const { column, equals } = p.visibleWhen;
        if (!SAFE_IDENT.test(column)) throw new Error(`rls-generator: unsafe visibleWhen column "${column}" on table ${table}`);
        const vis = typeof equals === 'boolean'
          ? `${column} IS ${equals ? 'TRUE' : 'FALSE'}`
          : `${column} = '${equals.replace(/'/g, "''")}'`;
        const readers = [`(${vis})`];
        if (write !== 'false') readers.push(`(${write})`);
        if (!write.includes(`${ROLE} = 'admin'`)) readers.push(`${ROLE} = 'admin'`);
        read = readers.join(' OR ');
      } else {
        read = 'true';
      }
      break;
    }
    case 'authenticated':
      // SECURITY (anon empty-string leak — pre-existing, surfaced by the first `authenticated` table):
      // a custom GUC reverts to '' (NOT NULL) on a POOLED connection after a prior SET LOCAL, so a bare
      // `${UID} IS NOT NULL` is TRUE for an ANONYMOUS request on a warm gateway connection → anon would
      // read/write members-only rows. NULLIF(${UID}, '') collapses both '' and NULL to NULL ⇒ anon (no
      // verified identity) is rejected deterministically, independent of connection warmth. (`owner`/`role`
      // are already empty-safe: `col = ''` / `'' = 'role'` match nothing. The related anon-write edge this
      // once flagged on the owner-column DEFAULT was CLOSED by R7 below: the DEFAULT is NULLIF-guarded too
      // (`SET DEFAULT NULLIF(${UID}, '')`), so an anon insert stamps NULL rather than landing in a shared
      // '' bucket. Corrected 2026-08-14 — the follow-up had been done for a phase and the note outlived it.)
      read = `NULLIF(${UID}, '') IS NOT NULL`;
      write = `NULLIF(${UID}, '') IS NOT NULL`;
      break;
    case 'owner':
      // 🔒 SECURITY: NULLIF(${UID}, '') so an ANON request on a WARM pooled connection (whose
      // custom GUC reverts to '' after a prior SET LOCAL, NOT NULL) can never land in / read back a shared
      // '' owner bucket. Pre-fix, the owner DEFAULT stamped '' and `ownerCol = ''` matched it ⇒ anons read
      // each other's rows + an anon INSERT succeeded into the '' bucket. NULLIF collapses '' → NULL, so the
      // DEFAULT stamps NULL and `ownerCol = NULL` is never TRUE ⇒ anon is rejected deterministically,
      // independent of connection warmth. Mirrors the `authenticated` fix; the DEFAULT below is guarded too.
      read = `${p.ownerColumn} = NULLIF(${UID}, '')`;
      write = `${p.ownerColumn} = NULLIF(${UID}, '')`;
      break;
    case 'role':
      // The role LITERAL is manifest-authored (Trio selects from the closed vocabulary), but safeIdent it
      // anyway — it is interpolated into the policy, so an unsafe value would be an injection surface
      //. The CALLER's role is separately driven from the GRANT, never the token.
      if (!SAFE_IDENT.test(p.role)) throw new Error(`rls-generator: unsafe role "${p.role}" on table ${table}`);
      read = `${ROLE} = '${p.role}'`;
      write = `${ROLE} = '${p.role}'`;
      break;
    case 'managed':
      // G1 /  — owner-OR-admin (the WEDGE's active half). Each member reads/writes ONLY their own rows
      // (the NULLIF'd owner test, R7-anon-safe); a caller carrying the reserved `admin` role reads/writes
      // ALL rows. `admin` comes from the Trivial GRANT (grants.ts → app.user_role GUC), NEVER a token claim
      // — and the super-write is a WIDENED RLS USING under the same SET ROLE app_<pid>,
      // so it is RLS-native (no BYPASSRLS) and the between-tenant wall still holds. Anon-safe: `'' = 'admin'`
      // is false, so an anon (role GUC '') gets neither branch.
      read = `${p.ownerColumn} = NULLIF(${UID}, '') OR ${ROLE} = 'admin'`;
      write = `${p.ownerColumn} = NULLIF(${UID}, '') OR ${ROLE} = 'admin'`;
      break;
  }
  // The owner STAMP (the GUC default) — emitted for ANY table that declares an ownerColumn (owner / managed,
  // or authenticated/public/role carrying an `owner` field rule). For owner/managed it scopes RLS (above)
  // AND stamps the column unforgeable; for the others it ONLY stamps (RLS unchanged) so the per-field `owner`
  // projection has an UNSPOOFABLE row-owner to test against. R7: NULLIF(${UID}, '') so an ANON
  // insert on a WARM connection stamps NULL — not the shared '' bucket (the sibling of the owner-predicate
  // fix above; an anon write is then RLS-rejected by `ownerCol = NULL`). columnsOf still detects this column
  // as the owner stamp (its regex matches `current_setting('app.user_id'` inside the NULLIF).
  const ownerColumn = p.ownerColumn;
  if (ownerColumn) {
    if (!SAFE_IDENT.test(ownerColumn)) throw new Error(`rls-generator: unsafe ownerColumn "${ownerColumn}" on table ${table}`);
    lines.push(`ALTER TABLE ${table} ALTER COLUMN ${ownerColumn} SET DEFAULT NULLIF(${UID}, '');`);
  }
  // the maker plane's unforgeable curation disjunct. Every policy —
  // SELECT included — admits `app.user_role = 'trivial:maker'`, the role the OWNER-GATED maker
  // plane (ownerManaged*/trash/restore in dynamic-data.ts + runtime-api.ts) sets server-side.
  // End-users can NEVER carry it: grants.ts SAFE_ROLE and the manifest's role safeIdent both
  // reject ':' by construction (and the mock-auth path isSafeRole-filters). SELECT carries the
  // disjunct because Postgres ANDs the SELECT policy into row-targeting UPDATE/DELETE (WHERE id /
  // RETURNING read existing rows) — without it the plane's write disjunct is unreachable on any
  // shape whose read predicate excludes it (managed, hidden visibleWhen rows, owner/role/
  // authenticated) — verified empirically in PGLite (the 0088 panel). accessFromQual (+ the
  // pglite mirror) STRIPS this canonical last disjunct before labeling, so Data-app labels and
  // the access-widened rank are unchanged. End-user semantics don't move: the disjunct is
  // unmintable. A pure `false` INSERT stays literally `(false)` — seed.ts's writeDenied refresh
  // detector keys on it (consequence: the plane cannot INSERT into read-only public tables, and
  // its live edits to REFRESHABLE tables are reverted by the next publish's refresh — documented).
  const MAKER = `${ROLE} = 'trivial:maker'`;
  lines.push(`CREATE POLICY ${table}_select ON ${table} FOR SELECT USING (${read} OR ${MAKER});`);
  // insert:'anyone': INSERT opens to everyone while read/update/delete
  // keep the base access. public+anyone = append-only wall (update/delete
  // stay false); owner+anyone = inbox (anon stamp NULL via the DEFAULT →
  // owned by no one; a signed-in submitter stamps their sub and keeps the
  // owner-scoped update/delete). The stamp stays unforgeable either way.
  const insertAnyone = (p as { insertAnyone?: boolean }).insertAnyone;
  const insertCheck = insertAnyone ? 'true' : write === 'false' ? 'false' : `${write} OR ${MAKER}`;
  lines.push(`CREATE POLICY ${table}_insert ON ${table} FOR INSERT WITH CHECK (${insertCheck});`);
  lines.push(`CREATE POLICY ${table}_update ON ${table} FOR UPDATE USING (${write} OR ${MAKER}) WITH CHECK (${write} OR ${MAKER});`);
  lines.push(`CREATE POLICY ${table}_delete ON ${table} FOR DELETE USING (${write} OR ${MAKER});`);
  // Per-field projection MARKERS — carried as column COMMENTs so the DB is the single source
  // of truth (columnsOf reads pg_description in the SAME introspection as the owner default). The closed
  // enum is all|owner|admin; a malformed/unknown rule is denied-by-default AT READ TIME
  // (runtime-api), never here. Emitted LAST + ONLY when `fields` is present ⇒ byte-identical for the four
  // existing types. A field rule on an unsafe/nonexistent column FAILS the publish (loud) rather than
  // silently dropping the rule (which would WIDEN the column to visible) — fail-closed at compile time.
  if (p.fields) {
    for (const [col, rule] of Object.entries(p.fields)) {
      if (!SAFE_IDENT.test(col)) throw new Error(`rls-generator: unsafe field column "${col}" on table ${table}`);
      lines.push(`COMMENT ON COLUMN "${table}"."${col}" IS 'trivial:field:read=${rule.read};write=${rule.write}';`);
    }
  }
  return lines.join('\n');
}

/** Emit the full RLS for a project's manifest — the byte-identical SQL loaded into BOTH
 *  PGLite (build) and the run-Postgres (real). */
export function generateAll(manifest: AccessManifest): string {
  return Object.entries(manifest)
    .map(([table, p]) => generateRls(table, p))
    .join('\n\n');
}
