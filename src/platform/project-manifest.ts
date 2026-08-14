/**
 * project-manifest — the per-project schema compiler + the H2 shared contract.
 *
 * ONE module, TWO front-ends. A maker declares their app's data — tables (columns + closed type
 * vocab) + access (the existing closed `Access` vocab) — in the project SOURCE at
 * `src/trivial.manifest.json`. Both authoring lanes write that same JSON: Trio via `write_file`, the
 * canvas Data-inspector via `PUT /source-content`. Both SEAMS resolve it through THIS compiler:
 *   - the RUN seam (seed.ts) → `applyRunSchema` provisions `app_<pid>` from the compiled spec.
 *   - the BUILD seam (iframe-shell.getIframeManifest → the SW's PGLite) → boots the same schema.
 * Because both seams compile the identical file through the byte-identical `generateAll`, build↔run
 * parity is free (that property, now per-project).
 *
 * THE SPLIT (Phase 2). The shared contract + the SECURITY-CRITICAL validator (`validateManifest`,
 * closed vocabs, `safeIdent`, `ManifestError`, the types) live in the dependency-free, browser-safe
 * `project-manifest-schema.ts` — imported here AND mirrored into the ui (the canvas pre-validates
 * client-side through the SAME validator, one source of truth). This module RE-EXPORTS all of it (so
 * `seed.ts` et al. resolve the public API unchanged) and adds the server-only half: the column→DDL
 * COMPILER (`compileManifest` — the ONE new injection surface, hence `assertIdent` at every
 * interpolation + the closed type vocab), the `generateAll` RLS passthrough, and the `fs` resolvers.
 * The compiler stays server-side because it needs the RLS generator; the browser never compiles DDL
 * (it reads the generated DDL back from the live build DB).
 *
 * ABSENCE MEANS EMPTY: absent file ⇒ `resolveProjectSpec` returns null ⇒ the seams provision NOTHING
 * (the run seam seeds no `app_<pid>` schema, the build seam boots an empty substrate, the auth seam
 * provisions no org/client). The  demo fallback (PROD_SPEC / the inlined PGLITE_* consts) is
 * retired — it existed while the tier was dark; live, a maker who declared nothing gets nothing.
 * The seams only resolve under `DYNAMIC_APPS_ENABLED`.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { generateAll, type Access, type AccessManifest } from './rls-generator.js';
import {
  validateManifest,
  isSafeIdent,
  ManifestError,
  COLUMN_TYPES,
  MANIFEST_REL_PATH,
  type ProjectManifest,
  type TableManifest,
} from './project-manifest-schema.js';

// Re-export the shared contract + validator so the public API of this module is unchanged: every
// consumer that resolved `validateManifest` / `ManifestError` / `ProjectManifest` / the closed
// vocabs / `MANIFEST_REL_PATH` from `./project-manifest.js` still does. The single source of the
// validator is `project-manifest-schema.ts`; this line just forwards it.
export * from './project-manifest-schema.js';

const err = (m: string) => new ManifestError(m);

/** The compiled spec BOTH seams consume: the column→DDL output + the access manifest `generateAll`
 *  turns into RLS. (Owned here — the compiler's output type. seed.ts re-exports it for back-compat.) */
export interface RunSchemaSpec { ddl: string; manifest: AccessManifest; }

/** The build-seam schema shipped in the `getIframeManifest` response — what the SW's PGLite boots
 *  (DDL + the byte-identical generated RLS + role grants) instead of the inlined PGLITE_* consts. */
export interface BuildDataSchema { ddl: string; rls: string; grants: string; }

// ---------------------------------------------------------------------------
// The injection defense at the interpolation boundary — belt-and-suspenders.
// SECURITY-CRITICAL: every identifier interpolated into emitted DDL passes this,
// even if a caller bypasses `validateManifest`. Reuses the shared `isSafeIdent`.
// ---------------------------------------------------------------------------
function assertIdent(kind: string, name: string): string {
  if (!isSafeIdent(name)) throw new ManifestError(`unsafe ${kind} identifier: ${JSON.stringify(name)}`);
  return name;
}

// ---------------------------------------------------------------------------
// compileManifest — the column→DDL generator + the access passthrough.
// ---------------------------------------------------------------------------

/** Compile a (validated) manifest into the `RunSchemaSpec` both seams consume: the
 *  `CREATE TABLE IF NOT EXISTS` DDL + the `AccessManifest` `generateAll` turns into RLS. The DDL
 *  builder uses ONLY `safeIdent`-asserted identifiers (assertIdent at every interpolation) + the
 *  closed type vocab — no raw interpolation. Idempotent DDL (IF NOT EXISTS) so re-apply is additive,
 *  matching the run-seam migrate + the build-seam re-boot. */
export function compileManifest(m: ProjectManifest): RunSchemaSpec {
  const manifest: AccessManifest = {};
  const ddl: string[] = [];
  for (const [table, t] of Object.entries(m.tables)) {
    assertIdent('table', table);
    manifest[table] = toAccess(t);
    ddl.push(compileTableDdl(table, t));
  }
  return { ddl: ddl.join('\n'), manifest };
}

/** Reconstruct the discriminated `Access` object from a table's flat manifest keys — the passthrough
 *  half. `generateAll` re-`safeIdent`s ownerColumn / role / field columns, so this is intentionally a
 *  thin mapping, not a second validator. This is also the tsc boundary that enforces the schema
 *  module's type vocab still matches rls-generator's `Access` (a drift fails to compile here). */
function toAccess(t: TableManifest): Access {
  switch (t.access) {
    case 'public':
      return {
        access: 'public',
        ...(t.insert === 'anyone' ? { insertAnyone: true } : {}),
        ...(t.write ? { write: t.write } : {}),
        ...(t.role ? { role: t.role } : {}),
        ...(t.visibleWhen ? { visibleWhen: t.visibleWhen } : {}),
        ...(t.ownerColumn ? { ownerColumn: t.ownerColumn } : {}),
        ...(t.fields ? { fields: t.fields } : {}),
      };
    case 'authenticated':
      return { access: 'authenticated', ...(t.ownerColumn ? { ownerColumn: t.ownerColumn } : {}), ...(t.fields ? { fields: t.fields } : {}) };
    case 'owner':
      return { access: 'owner', ownerColumn: t.ownerColumn as string, ...(t.insert === 'anyone' ? { insertAnyone: true } : {}), ...(t.fields ? { fields: t.fields } : {}) };
    case 'role':
      return { access: 'role', role: t.role as string, ...(t.ownerColumn ? { ownerColumn: t.ownerColumn } : {}), ...(t.fields ? { fields: t.fields } : {}) };
    case 'managed':
      return { access: 'managed', ownerColumn: t.ownerColumn as string, ...(t.fields ? { fields: t.fields } : {}) };
  }
}

/** Whether a table gets the implicit `owner text` column: access ∈ {owner, managed} always declare
 *  ownerColumn; other access types get it only when they declare ownerColumn (to carry an `owner`
 *  field rule — the Shape-3 model). Nullable ONLY for `managed` (an admin/maker insert leaves it
 *  NULL); NOT NULL elsewhere — mirrors the seeded schema (notes/npcs NOT NULL, submissions nullable).
 *  The generator (generateRls) later adds the unforgeable `SET DEFAULT NULLIF(user_id,'')`. */
function compileTableDdl(table: string, t: TableManifest): string {
  assertIdent('table', table);
  const cols: string[] = ['id serial PRIMARY KEY'];
  if (t.ownerColumn) {
    const oc = assertIdent('ownerColumn', t.ownerColumn);
    // Nullable for managed (admin/maker inserts leave it NULL) AND for
    // insert:'anyone' (an anonymous insert stamps NULL via the DEFAULT —
    // NOT NULL would 23502 the whole feature).
    cols.push(`${oc} text${t.access === 'managed' || t.insert === 'anyone' ? '' : ' NOT NULL'}`);
  }
  for (const [col, type] of Object.entries(t.columns)) {
    assertIdent('column', col);
    if (!COLUMN_TYPES.has(type)) throw err(`table "${table}".${col}: unknown type ${JSON.stringify(type)}`);
    cols.push(`${col} ${type}`); // `type` is one of 8 closed literals → safe without escaping
  }
  cols.push('created_at timestamptz NOT NULL DEFAULT now()');
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')});`;
}

// ---------------------------------------------------------------------------
// The build-seam schema — the constant grants + the compiled ddl/rls.
// ---------------------------------------------------------------------------

/** The build-side PGLite is single-tenant (one project per in-browser SW) → one fixed `app_user`
 *  role. Grants are a schema-wide CONSTANT (no table-name interpolation → zero injection surface —
 *  the DDL is the sole injection surface), mirroring the run side's `roleWallSql` model: full DML on
 *  every table, RLS (FORCE) is the real gate. `app_user` is NOLOGIN; the substrate `SET LOCAL ROLE`s
 *  into it for the tenant-query path. */
const BUILD_GRANTS = [
  `DO $$ BEGIN CREATE ROLE app_user NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;`,
].join('\n');

/** Assemble the build-seam schema from a compiled spec — the DDL + the byte-identical generated RLS
 *  (`generateAll`, the SAME output the run seam replays) + the constant grants. Shipped in the
 *  `getIframeManifest` response; the SW's PGLite boots it. */
export function compileBuildSchema(spec: RunSchemaSpec): BuildDataSchema {
  return { ddl: spec.ddl, rls: generateAll(spec.manifest), grants: BUILD_GRANTS };
}

// ---------------------------------------------------------------------------
// resolveProjectSpec — read + validate + compile src/trivial.manifest.json.
// ---------------------------------------------------------------------------

/** Resolve a project's manifest into a compiled `RunSchemaSpec`, or `null` when ABSENT (the common
 *  static / no-manifest case — the seams then provision NOTHING: absence means empty, never a demo).
 *  A PRESENT-but-malformed manifest THROWS a `ManifestError` (the caller surfaces / logs it non-fatal),
 *  so a bad manifest is never silently ignored. */
export async function resolveProjectSpec(sourceDir: string): Promise<RunSchemaSpec | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceDir, MANIFEST_REL_PATH), 'utf-8');
  } catch {
    return null; // absent — the byte-identical fallback path
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw err('invalid JSON — ' + (e as Error).message);
  }
  return compileManifest(validateManifest(parsed));
}

/** Convenience for the build seam: resolve + compile straight to the `BuildDataSchema` the SW boots,
 *  or `null` when absent. */
export async function resolveBuildSchema(sourceDir: string): Promise<BuildDataSchema | null> {
  const spec = await resolveProjectSpec(sourceDir);
  return spec ? compileBuildSchema(spec) : null;
}

/** PRESENCE check only — is this a dynamic(-intent) project? True iff `src/trivial.manifest.json`
 *  exists in the source tree, WITHOUT parsing or compiling it (a present-but-malformed manifest still
 *  marks the project as dynamic — the maker is mid-authoring, and consumers like Trio's
 *  `PackContext.isDynamicProject` must not flip back to static semantics on a typo). Cheap
 *  (one fs.access), never throws. */
export async function projectHasManifest(sourceDir: string): Promise<boolean> {
  // Content-aware since the 2026-07-04 design shift: the scaffold
  // ships a DORMANT manifest ({tables:{}}) from birth, so presence no
  // longer means intent — DECLARED TABLES do. Non-throwing: a malformed
  // manifest still reads as dynamic intent (someone is mid-edit).
  try {
    const raw = await fs.readFile(path.join(sourceDir, MANIFEST_REL_PATH), 'utf8');
    try {
      const parsed = JSON.parse(raw) as { tables?: Record<string, unknown> };
      return Object.keys(parsed.tables ?? {}).length > 0;
    } catch {
      return true; // unparseable = someone is editing it = intent
    }
  } catch {
    return false;
  }
}
