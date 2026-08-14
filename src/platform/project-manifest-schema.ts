/**
 * project-manifest-schema — the BROWSER-SAFE half of the manifest compiler: the shared
 * contract (types + closed vocabularies) and the SECURITY-CRITICAL validator (`safeIdent` + closed
 * vocab + `validateManifest`). Deliberately dependency-free — NO `fs`, NO `rls-generator` import,
 * NO node builtins — so it bundles into the browser unchanged.
 *
 * ⚠️  SINGLE SOURCE OF TRUTH — MIRRORED, KEEP BYTE-IDENTICAL.
 *     This file exists at BOTH:
 *       - the platform's own implementation   (server canonical)
 *       - the platform's own implementation                   (browser mirror)
 *     They MUST stay byte-identical — the validator is the app's ONE new injection surface, and a
 *     drift between the two copies is a security bug. A jest guard
 *     (__tests__/project-manifest-schema-sync.test.ts) fails CI if they diverge. Edit the server
 *     copy, then `cp` it to the ui copy (or vice-versa) — never hand-edit one alone.
 *
 * ONE validator, TWO callers. Both authoring lanes validate through THIS module before a byte is
 * written: the canvas Data-inspector pre-validates client-side (this browser mirror) so a bad
 * manifest surfaces inline instead of being silently dropped at `resolveProjectSpec`; the server
 * re-validates on read (the api copy, re-exported by project-manifest.ts). The COMPILE half
 * (`compileManifest` → DDL + the `generateAll` RLS passthrough) lives in project-manifest.ts because
 * it needs the server-only RLS generator — the browser never compiles DDL (it reads the generated
 * DDL back from the live build DB), so only the validator is shared here.
 *
 * The type unions below MIRROR rls-generator.ts (`FieldAccess`/`FieldRule`/`FieldRules` + the
 * `Access['access']` discriminant); they are re-declared here to keep this module dependency-free,
 * and project-manifest.ts bridges them into the real `Access` (tsc enforces compatibility at that
 * boundary — a drift in the rls-generator vocab fails to compile there).
 */

// ---------------------------------------------------------------------------
// The shared contract — the manifest shape (defined once; both lanes import).
// ---------------------------------------------------------------------------

/** Closed column-type vocabulary. A type outside this set is REJECTED at validate time — the closed
 *  set is what lets `compileManifest` interpolate the type into DDL without escaping (each value is a
 *  known-safe SQL literal). Deliberately small + AI-selectable, mirroring the closed `Access` vocab. */
export type ColumnType =
  | 'text' | 'int' | 'bigint' | 'numeric' | 'boolean' | 'timestamptz' | 'date' | 'jsonb';
/** Ordered list (the UI dropdown reads this) — the closed `Set` is derived from it, so one source. */
export const COLUMN_TYPE_LIST: readonly ColumnType[] = [
  'text', 'int', 'bigint', 'numeric', 'boolean', 'timestamptz', 'date', 'jsonb',
];
const COLUMN_TYPES: ReadonlySet<string> = new Set<string>(COLUMN_TYPE_LIST);
export { COLUMN_TYPES };

/** The access-type discriminant vocabulary — mirrors rls-generator's `Access['access']`. */
export type AccessType = 'public' | 'authenticated' | 'owner' | 'role' | 'managed';
export const ACCESS_TYPE_LIST: readonly AccessType[] = [
  'public', 'authenticated', 'owner', 'role', 'managed',
];
const ACCESS_TYPES: ReadonlySet<string> = new Set<string>(ACCESS_TYPE_LIST);
export { ACCESS_TYPES };

/** the write-axis vocabulary (valid only with access "public"). */
export type WriteAxis = 'admin' | 'owner' | 'authenticated' | 'role';
export const WRITE_AXIS_LIST: readonly WriteAxis[] = ['admin', 'owner', 'authenticated', 'role'];
const WRITE_AXES: ReadonlySet<string> = new Set<string>(WRITE_AXIS_LIST);
export { WRITE_AXES };

/** The per-field read/write vocabulary — mirrors rls-generator's `FieldAccess`. */
export type FieldAccess = 'all' | 'owner' | 'admin';
export interface FieldRule { read: FieldAccess; write: FieldAccess; }
export type FieldRules = Record<string, FieldRule>;
export const FIELD_ACCESS_LIST: readonly FieldAccess[] = ['all', 'owner', 'admin'];
const FIELD_ACCESS: ReadonlySet<string> = new Set<string>(FIELD_ACCESS_LIST);
export { FIELD_ACCESS };

/** Implicit reserved columns the compiler always emits — a maker may NOT redeclare them in `columns`
 *  (nor the active owner column). `id serial PRIMARY KEY` + `created_at timestamptz` are universal. */
const RESERVED_COLS: ReadonlySet<string> = new Set(['id', 'created_at']);

/** One table's declaration: its data columns (name → closed type) + its access policy (the flat keys
 *  that map 1:1 onto the `Access` union) + optional per-field projection. */
export interface TableManifest {
  columns: Record<string, ColumnType>;
  access: AccessType;
  ownerColumn?: string;
  role?: string;
  fields?: FieldRules;
  /** Who may CREATE rows — orthogonal to `access` (who reads/owns). The one
   *  value, 'anyone', opens INSERT to anonymous visitors (2026-07-05:
   *  guestbook/contact-form/waitlist). Valid ONLY with access public|owner. */
  insert?: 'anyone';
  /** the orthogonal write axis (valid only with access "public"): the world reads, the
   *  declared audience writes. 'owner' requires ownerColumn — any signed-in user may create (the
   *  stamp makes the row theirs) and edits only their own: a forum. 'role' requires the role key.
   *  Absent = curated-public (writes denied, today's semantics). */
  write?: WriteAxis;
  /** value-dependent row visibility (valid only with access "public"), closed to ONE
   *  shape: a DECLARED text|boolean column compared to a literal. Hidden rows stay visible to
   *  write-holders + admin (draft semantics); NULL fails the predicate — unset means draft. */
  visibleWhen?: { column: string; equals: string | boolean };
}

/** The per-project data manifest — `src/trivial.manifest.json`. The H2 handshake artifact. */
export interface ProjectManifest {
  version: 1;
  tables: Record<string, TableManifest>;
}

// ---------------------------------------------------------------------------
// The injection defense — mirrors rls-generator.ts:62 / index.ts's safeIdent.
// SECURITY-CRITICAL: every identifier interpolated into emitted DDL passes this.
// ---------------------------------------------------------------------------
export const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;
export function isSafeIdent(name: unknown): name is string {
  return typeof name === 'string' && SAFE_IDENT.test(name);
}

/** PostgreSQL reserved words (pg_get_keywords() catcode R|T, PG 18) — names that cannot appear
 *  UNQUOTED as a table/column identifier. The compiler deliberately emits unquoted identifiers
 *  (reject-don't-escape, the same call as the lowercase rule below), so a manifest name in this
 *  set would pass validation, then abort the ENTIRE provisioning transaction with a Postgres
 *  syntax error at publish time — the site ships without its data layer for one bad name
 *  (found 2026-08-08 by the shape-diversity harness: a table named "order"). Reject it here,
 *  where both authoring lanes get the message immediately. */
const SQL_RESERVED: ReadonlySet<string> = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization',
  'binary', 'both', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently',
  'constraint', 'create', 'cross', 'current_catalog', 'current_date', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze',
  'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect',
  'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
  'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select',
  'session_user', 'similar', 'some', 'symmetric', 'system_user', 'table', 'tablesample', 'then',
  'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
  'where', 'window', 'with',
]);
export { SQL_RESERVED };

export class ManifestError extends Error {
  constructor(message: string) { super('trivial.manifest.json: ' + message); this.name = 'ManifestError'; }
}
const err = (m: string) => new ManifestError(m);

// ---------------------------------------------------------------------------
// validateManifest — closed vocab + safeIdent on EVERY ident; reject the rest.
// ---------------------------------------------------------------------------

/** Validate an untrusted parsed JSON value into a typed `ProjectManifest`, or THROW a clear error.
 *  The gate is total: table + column + ownerColumn + role + field-column identifiers each pass
 *  `safeIdent`; column types, the access type, and the field read/write values each pass their CLOSED
 *  vocabulary. Anything else — an injection attempt (`"body; DROP TABLE"`, `"text) --"`), an unknown
 *  type/access, a missing required key — is rejected. Both lanes call this (the canvas pre-validates
 *  client-side; the manifest-write analysis for the publish card calls it) before the JSON is ever compiled. */
export function validateManifest(json: unknown): ProjectManifest {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw err('must be a JSON object');
  const m = json as Record<string, unknown>;
  if (m.version !== 1) throw err('version must be 1');
  if (!m.tables || typeof m.tables !== 'object' || Array.isArray(m.tables)) throw err('tables must be an object');

  const tables: Record<string, TableManifest> = {};
  for (const [name, raw] of Object.entries(m.tables as Record<string, unknown>)) {
    if (!isSafeIdent(name)) throw err(`unsafe table name ${JSON.stringify(name)}`);
    if (name !== name.toLowerCase()) throw err(`table name must be lowercase snake_case (got ${JSON.stringify(name)}) — Postgres folds unquoted identifiers, so a camelCase name is created lowercase but queried case-preserved and silently 404s`);
    if (name.startsWith('_')) throw err(`table names starting with "_" are reserved for the platform (got ${JSON.stringify(name)})`);
    if (SQL_RESERVED.has(name)) throw err(`table name ${JSON.stringify(name)} is a SQL reserved word and cannot be used — rename it (e.g. "order" → "orders", "user" → "users")`);
    tables[name] = validateTable(name, raw);
  }
  // Empty tables is VALID — the dormant state (the 2026-07-04 design shift:
  // the scaffold ships the manifest from birth; declaring data = ADDING a
  // table to it, and dynamic intent keys on CONTENT, not file presence).
  // Provisioning over zero tables is naturally a no-op everywhere.
  return { version: 1, tables };
}

function validateTable(name: string, raw: unknown): TableManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw err(`table "${name}" must be an object`);
  const t = raw as Record<string, unknown>;

  // columns — name safeIdent'd, type in the closed vocab, never a reserved implicit column.
  if (!t.columns || typeof t.columns !== 'object' || Array.isArray(t.columns)) {
    throw err(`table "${name}".columns must be an object`);
  }
  const columns: Record<string, ColumnType> = {};
  for (const [col, type] of Object.entries(t.columns as Record<string, unknown>)) {
    if (!isSafeIdent(col)) throw err(`table "${name}": unsafe column name ${JSON.stringify(col)}`);
    if (col !== col.toLowerCase()) throw err(`table "${name}": column names must be lowercase snake_case (got ${JSON.stringify(col)}) — camelCase silently breaks at the data layer`);
    if (col.startsWith('_')) throw err(`table "${name}": column names starting with "_" are reserved for the platform (e.g. the "_hp" honeypot) — got ${JSON.stringify(col)}`);
    if (RESERVED_COLS.has(col)) throw err(`table "${name}": "${col}" is reserved (id + created_at are implicit)`);
    if (SQL_RESERVED.has(col)) throw err(`table "${name}": column name ${JSON.stringify(col)} is a SQL reserved word and cannot be used — rename it (e.g. "order" → "sort_order", "desc" → "description")`);
    if (typeof type !== 'string' || !COLUMN_TYPES.has(type)) {
      throw err(`table "${name}".${col}: unknown type ${JSON.stringify(type)} (allowed: ${[...COLUMN_TYPES].join('|')})`);
    }
    columns[col] = type as ColumnType;
  }

  // access — the closed discriminant.
  const access = t.access;
  if (typeof access !== 'string' || !ACCESS_TYPES.has(access)) {
    throw err(`table "${name}".access must be one of ${[...ACCESS_TYPES].join('|')}`);
  }

  // ownerColumn / role — safeIdent'd when present.
  let ownerColumn: string | undefined;
  if (t.ownerColumn !== undefined) {
    if (!isSafeIdent(t.ownerColumn)) throw err(`table "${name}": unsafe ownerColumn ${JSON.stringify(t.ownerColumn)}`);
    if (t.ownerColumn !== t.ownerColumn.toLowerCase()) throw err(`table "${name}": ownerColumn must be lowercase snake_case (got ${JSON.stringify(t.ownerColumn)})`);
    if (SQL_RESERVED.has(t.ownerColumn)) throw err(`table "${name}": ownerColumn ${JSON.stringify(t.ownerColumn)} is a SQL reserved word and cannot be used`);
    ownerColumn = t.ownerColumn;
  }
  let role: string | undefined;
  if (t.role !== undefined) {
    if (!isSafeIdent(t.role)) throw err(`table "${name}": unsafe role ${JSON.stringify(t.role)}`);
    role = t.role;
  }

  // fields — column safeIdent'd, read/write in the closed FieldAccess vocab.
  let fields: FieldRules | undefined;
  if (t.fields !== undefined) {
    if (!t.fields || typeof t.fields !== 'object' || Array.isArray(t.fields)) throw err(`table "${name}".fields must be an object`);
    fields = {};
    for (const [fcol, ruleRaw] of Object.entries(t.fields as Record<string, unknown>)) {
      if (!isSafeIdent(fcol)) throw err(`table "${name}": unsafe field column ${JSON.stringify(fcol)}`);
      // A field rule projects a DECLARED data column — else generateAll emits a COMMENT on a phantom
      // column that fails at apply. (Fail-closed at validate, not a cryptic apply-time error.)
      if (!(fcol in columns)) throw err(`table "${name}".fields.${fcol}: no such column (declare it in columns first)`);
      if (!ruleRaw || typeof ruleRaw !== 'object' || Array.isArray(ruleRaw)) throw err(`table "${name}".fields.${fcol} must be {read,write}`);
      const rule = ruleRaw as Record<string, unknown>;
      if (typeof rule.read !== 'string' || !FIELD_ACCESS.has(rule.read)) throw err(`table "${name}".fields.${fcol}.read must be one of ${[...FIELD_ACCESS].join('|')}`);
      if (typeof rule.write !== 'string' || !FIELD_ACCESS.has(rule.write)) throw err(`table "${name}".fields.${fcol}.write must be one of ${[...FIELD_ACCESS].join('|')}`);
      fields[fcol] = { read: rule.read as FieldAccess, write: rule.write as FieldAccess } satisfies FieldRule;
    }
  }

  // cross-key requirements (mirror the Access union's shape).
  if ((access === 'owner' || access === 'managed') && !ownerColumn) {
    throw err(`table "${name}": access "${access}" requires ownerColumn`);
  }
  if (access === 'role' && !role) throw err(`table "${name}": access "role" requires role`);

  // insert — the anonymous-write modifier. Closed to one value; only
  // the two decided combos pass (public+anyone = append-only wall;
  // owner+anyone = inbox/RSVP). Everything else fail-closes.
  const insert = (t as { insert?: unknown }).insert;
  if (insert !== undefined) {
    if (insert !== 'anyone') throw err(`table "${name}".insert must be 'anyone' (or omitted)`);
    if (access !== 'public' && access !== 'owner') {
      throw err(`table "${name}": insert "anyone" is only valid with access "public" or "owner"`);
    }
  }
  const fieldNeedsOwner = fields && Object.values(fields).some((r) => r.read === 'owner' || r.write === 'owner');
  if (fieldNeedsOwner && !ownerColumn) throw err(`table "${name}": an "owner" field rule requires ownerColumn`);
  if (ownerColumn && columns[ownerColumn]) throw err(`table "${name}": ownerColumn "${ownerColumn}" collides with a declared column (it is implicit)`);

  // write, the orthogonal write axis. Public-only in v1 (orthogonal SYNTAX, closed
  // COMBINATION space): 'owner' needs the stamp column, 'role' needs the role key.
  const write = (t as { write?: unknown }).write;
  let writeAxis: WriteAxis | undefined;
  if (write !== undefined) {
    if (typeof write !== 'string' || !WRITE_AXES.has(write)) {
      throw err(`table "${name}".write must be one of ${[...WRITE_AXES].join('|')} (or omitted)`);
    }
    if (access !== 'public') {
      throw err(`table "${name}": write is only valid with access "public" — the other access types already bind their write audience`);
    }
    if (write === 'owner' && !ownerColumn) throw err(`table "${name}": write "owner" requires ownerColumn`);
    if (write === 'role' && !role) throw err(`table "${name}": write "role" requires role`);
    writeAxis = write as WriteAxis;
  }

  // visibleWhen. One closed shape; the column must be a DECLARED text|boolean column and
  // the literal typed to match. Length-capped + control-char-free so the generator's
  // quote-escaping is the only transform it ever needs.
  const vw = (t as { visibleWhen?: unknown }).visibleWhen;
  let visibleWhen: { column: string; equals: string | boolean } | undefined;
  if (vw !== undefined) {
    if (access !== 'public') throw err(`table "${name}": visibleWhen is only valid with access "public" in v1`);
    if (!vw || typeof vw !== 'object' || Array.isArray(vw)) throw err(`table "${name}".visibleWhen must be {column, equals}`);
    const v = vw as Record<string, unknown>;
    if (!isSafeIdent(v.column)) throw err(`table "${name}".visibleWhen: unsafe column ${JSON.stringify(v.column)}`);
    const colType = columns[v.column as string];
    if (!colType) throw err(`table "${name}".visibleWhen.column: no such column (declare it in columns first)`);
    if (colType !== 'text' && colType !== 'boolean') {
      throw err(`table "${name}".visibleWhen.column must be a text or boolean column (got ${colType})`);
    }
    if (colType === 'boolean') {
      if (typeof v.equals !== 'boolean') throw err(`table "${name}".visibleWhen.equals must be a boolean (the column is boolean)`);
    } else {
      if (typeof v.equals !== 'string' || v.equals.length === 0 || v.equals.length > 64) {
        throw err(`table "${name}".visibleWhen.equals must be a non-empty string (max 64 chars)`);
      }
      if (/[\x00-\x1f]/.test(v.equals)) throw err(`table "${name}".visibleWhen.equals must not contain control characters`);
    }
    visibleWhen = { column: v.column as string, equals: v.equals as string | boolean };
  }

  return { columns, access: access as AccessType, ownerColumn, role, fields, insert: insert as 'anyone' | undefined, write: writeAxis, visibleWhen };
}

// ---------------------------------------------------------------------------
// The manifest's on-disk location within a project's source tree.
// ---------------------------------------------------------------------------

/** Mirrors `src/trivial.config.json` (JSON, server-validated, no eval). Both the canvas write
 *  (`PUT /source-content`) and the server read (`resolveProjectSpec`) key off this path. */
export const MANIFEST_REL_PATH = 'src/trivial.manifest.json';
