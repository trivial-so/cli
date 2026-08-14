/**
 * dev-handler-runtime — the DEV half of the build│real compute symmetry: the user's bounded
 * `buildApp(ctx)` handler runs in the canvas preview Service Worker AGAINST THE IN-SW PGLite, mirroring the
 * proven publish path (workerd against run-PG). Same handler source, same structured `ctx` — only the ctx
 * BACKING differs.
 *
 *   publish (run):  worker-entry.ts → ctx.list/insert/update/remove → HTTP → gateway.ts → runtime-api.ts → run-PG
 *   dev (build):    THIS module     → ctx.list/insert/update/remove → in-SW PGLite (the  build substrate)
 *
 * The shim is the EXACT two lines `worker-entry.ts` runs — `const app = buildApp(ctx); return app.fetch(req)`
 * — but `ctx` is PGLite-backed. The ops compose the SAME SQL `runtime-api` composes (the gateway never lets a
 * handler author SQL), and each runs inside the build-side connection discipline `__devAsUser`: the role WALL
 * (`SET LOCAL ROLE app_user`) + the per-user identity GUCs (`app.user_id` / `app.user_role`), is_local=true →
 * txn-scoped. So the SAME generated RLS that scopes a published handler's reads/writes scopes them in dev:
 * owner-stamp from the verified identity, alice ⊥ bob, anon-blind — enforced by PGLite, not by the handler.
 * (PGLite-RLS faithfulness vs run-PG is proven in `__tests__/dev-handler-runtime.test.ts`; the run half is
 * the platform's handler conformance suite.) Author contract: `the platform docs`.
 *
 * DELIVERY: this file exports the runtime as a STRING (`DEV_HANDLER_RUNTIME_SOURCE`) spliced into the SW the
 * same way `pglite-substrate.ts` splices the build substrate (the SW is assembled as one ES-module string),
 * AND `loadDevRuntime()` instantiates the SAME bytes for node tests — so the test exercises the EXACT code
 * the SW runs (no parallel impl to drift). DARK: spliced only when `DYNAMIC_HANDLERS_ENABLED` (flag-off ⇒ the
 * SW is byte-identical); ZERO server compute (it runs in the browser SW); model-free.
 *
 * FIDELITY NOTE for the lead: row-level RLS is byte-faithful (same policies + role wall + GUCs, native to
 * PGLite). The that phase per-FIELD (column) READ projection is now MIRRORED here too (that phase follow-up): the dev
 * ctx reads each table's `trivial:field:` column COMMENTs and masks owner-only / role-gated columns for a
 * non-permitted reader using the SAME decision as the run side — `__devProjectRowShape` is a byte-faithful
 * port of `field-projection.ts` projectRowShape, PARITY-PINNED to it by an exhaustive test over the closed
 * rule × identity space (`__tests__/dev-handler-runtime.test.ts`). It is a strict column SUBTRACTION —
 * never a row/tenant widening — so a handler in dev sees the SAME masked columns it would in prod.
 * (Scope: the per-field WRITE gate — rejecting a withheld write with 403 — stays the run side's alone; in
 * the single-tenant build DB a dev write of a withheld field is a minor fidelity gap, not a leak. The
 * user-visible READ-masking gap is what this closes.)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The DATA CORE — the PGLite ctx machinery (idents, field projection, introspection, the RLS
 * connection discipline, and the four structured verbs). Split out of the handler runtime
 * (the parity harness) so it splices under DYNAMIC_APPS_ENABLED (`opts.pglite`) — BOTH the
 * /api/data dispatch (pglite-substrate.ts DATA_API_DISPATCH_SOURCE) and the that phase handler tier
 * (below; handlers ⊂ pglite) run on these same bytes, so verb semantics can never fork.
 * Authored as a string (the SW splices it): `String.raw`, no `${`, no nested backticks (SQL
 * placeholders by concatenation, `'$' + (i + 1)`), so a function-form `.replace()` can't mangle
 * it. Operates on an already-booted PGLite handle (`db`) — the same condition boots the
 * schema/RLS/grants; this never imports PGLite or any schema.
 */
export const DEV_DATA_CORE_SOURCE = String.raw`
// === dev data core — idents · projection · introspection · RLS ctx verbs (pglite-gated) ======
var __DEV_MAX_LIMIT = 200;
function __devSafeIdent(name) { return /^[a-z_][a-z0-9_]{0,62}$/i.test(String(name == null ? '' : name)); }
function __devCoerceId(id) { return (typeof id === 'number') ? id : (/^\d+$/.test(String(id)) ? Number(id) : id); }

// ── that phase per-FIELD READ projection (that phase follow-up) — the BYTE-FAITHFUL dev mirror of field-projection.ts.
// Parity-pinned to the run side by an exhaustive test (dev-handler-runtime.test.ts) over the closed rule ×
// identity space: the dev ctx masks the SAME owner-only / role-gated columns a non-permitted reader sees
// masked in prod. projectRowShape decides by RULE + caller ctx (NOT value-nullness), so feeding it the raw
// RLS-visible row yields the SAME key-set the run side produces after its in-engine NULL pass — the outputs
// byte-match. The deps below mirror field-projection.ts; only the collection types differ (Map↔Map for
// fields; an array here ↔ a Set on the run side for owner membership), which never changes the OUTPUT.

// Parse a 'trivial:field:read=<r>;write=<w>' column COMMENT → a {read, write} rule; null when not a field
// rule. DENIED-BY-DEFAULT: a value outside the closed enum (all|owner|admin) maps to 'deny' (fail-closed).
function __devParseFieldRule(comment) {
  if (!comment) return null;
  var c = String(comment).trim();
  var PREFIX = 'trivial:field:';
  if (c.indexOf(PREFIX) !== 0) return null;
  var body = c.slice(PREFIX.length);
  var read, write;
  var parts = body.split(';');
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    var k = parts[i].slice(0, eq).trim();
    var val = parts[i].slice(eq + 1).trim();
    if (k === 'read') read = val; else if (k === 'write') write = val;
  }
  function axis(v) { return v === 'all' ? 'all' : v === 'owner' ? 'owner' : v === 'admin' ? 'admin' : 'deny'; }
  return { read: axis(read), write: axis(write) };
}

// PURE: is col readable given its rule + the caller ctx? all ⇒ always; owner ⇒ only the row owner; admin ⇒
// only a granted admin; deny / unknown ⇒ never. Strictly subtractive (the caller already passed RLS).
function __devIsColumnReadable(rule, ctx) {
  var read = (rule == null) ? 'all' : rule.read;
  if (read === 'all') return true;
  if (read === 'owner') return ctx.isRowOwner;
  if (read === 'admin') return ctx.isAdmin;
  return false;
}

// PURE: may the caller WRITE col given its rule + ctx? — the byte-faithful dev mirror of
// field-projection.isColumnWritable (parity-pinned by test). all ⇒ yes; owner ⇒ only the row
// owner; admin ⇒ only a granted admin; deny / unknown ⇒ never.
function __devIsColumnWritable(rule, ctx) {
  var write = (rule == null) ? 'all' : rule.write;
  if (write === 'all') return true;
  if (write === 'owner') return ctx.isRowOwner;
  if (write === 'admin') return ctx.isAdmin;
  return false;
}

// per-value byte cap (run parity: runtime-api.oversizedValue). 64KiB default matches
// MAX_VALUE_BYTES; SW has no env so the parity default is hardcoded. Throws the SAME message shape
// the run side does, mapped to 400 by __dataMapError.
function __devAssertValueSizes(entries) {
  for (var vi = 0; vi < entries.length; vi++) {
    var vv = entries[vi][1];
    if (vv == null) continue;
    var vs = typeof vv === 'string' ? vv : JSON.stringify(vv);
    var vb = new TextEncoder().encode(vs).length;
    if (vb > 65536) throw new Error('value too large: "' + entries[vi][0] + '" is ' + vb + ' bytes (max 65536)');
  }
}
// REJECT (403 on the wire, never silently strip) any writable entry the caller may not write per
// its field rule — the dev mirror of runtime-api.rejectWithheldWrites, message BYTE-IDENTICAL
// (both the /api/data dispatch and the run controller map it to 403 { error: <msg> }).
function __devRejectWithheldWrites(entries, meta, ctx) {
  var denied = [];
  for (var i = 0; i < entries.length; i++) {
    if (!__devIsColumnWritable(meta.fields.get(entries[i][0]), ctx)) denied.push(entries[i][0]);
  }
  if (denied.length) throw new Error('forbidden: cannot write withheld field(s): ' + denied.join(', '));
}

// The single GUC-stamped owner column used to test row-ownership for 'owner' rules — null when there isn't
// EXACTLY one (0 ⇒ can't test; >1 ⇒ ambiguous), so 'owner' rules then FAIL CLOSED. safeIdent-guarded.
function __devOwnerColOf(meta) {
  if (meta.owner.length !== 1) return null;
  var col = meta.owner[0];
  return __devSafeIdent(col) ? col : null;
}

// App-side row projection — drop the KEYS a non-permitted reader may not see, leaving EXACTLY the readable
// set ({name, public_desc}, not {…, secret_motive: null}). isRowOwner recomputed independently (the row's
// owner value vs the caller id); anon (userId null) is never owner. Unruled tables short-circuit (the raw
// row). meta.fields is a Map (prototype-safe lookups for odd column idents), mirroring the run side.
function __devProjectRowShape(row, meta, userId, role) {
  if (!meta.fields || meta.fields.size === 0) return row;
  var ownerCol = __devOwnerColOf(meta);
  var ownerVal = ownerCol ? row[ownerCol] : undefined;
  var isRowOwner = ownerCol != null && userId != null && ownerVal != null && String(ownerVal) === String(userId);
  var isAdmin = role === 'admin' || role === 'trivial:maker'; //  run parity — inert in the SW (no maker plane), parity-true
  var out = {};
  for (var i = 0; i < meta.all.length; i++) {
    var col = meta.all[i];
    if (!(col in row)) continue;
    if (meta.owner.indexOf(col) >= 0 || __devIsColumnReadable(meta.fields.get(col), { isRowOwner: isRowOwner, isAdmin: isAdmin })) out[col] = row[col];
  }
  return out;
}

// Privileged introspection on the BASE handle (mirror of runtime-api.columnsOf, public schema): the table's
// columns, the GUC-stamped owner column(s) (whose DEFAULT references app.user_id), whether it has an id PK
// (keyset pagination), AND the per-field projection rules read from each column's COMMENT (the that phase markers
// the rls-generator compiles into the DB — same source-of-truth as runtime-api). Read outside __devAsUser so
// it never trips the app_user role's grants.
async function __devColumnsOf(db, table) {
  if (!__devSafeIdent(table)) throw new Error('invalid table: ' + table);
  var res = await db.query(
    "SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS def, col_description(c.oid, a.attnum) AS comment " +
    "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum " +
    "WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
    [table]
  );
  if (!res.rows.length) throw new Error('table not found: ' + table);
  var all = res.rows.map(function (r) { return r.name; });
  var owner = res.rows
    .filter(function (r) { return typeof r.def === 'string' && /current_setting\(\s*'app\.user_id'/i.test(r.def); })
    .map(function (r) { return r.name; });
  var fields = new Map();
  for (var j = 0; j < res.rows.length; j++) {
    var rule = __devParseFieldRule(res.rows[j].comment);
    if (rule) fields.set(res.rows[j].name, rule);
  }
  return { all: all, owner: owner, hasId: all.indexOf('id') >= 0, fields: fields };
}

// The build-side connection discipline — the mirror of runtime-api.withRequest: SET LOCAL ROLE app_user (the
// single-tenant build role wall) + the per-user identity GUCs (app.user_id / app.user_role), is_local=true →
// txn-scoped, self-cleaning. The default PGLite connection is superuser and BYPASSES RLS, so this SET LOCAL
// ROLE is the sole tenant-query path. The run side additionally rides a NOSUPERUSER pool + statement_timeout +
// COGS caps (server compute); dev has ZERO server compute, so those are intentionally absent.
async function __devAsUser(db, userId, role, fn) {
  return db.transaction(async function (tx) {
    await tx.exec('SET LOCAL ROLE app_user');
    await tx.query("SELECT set_config('app.user_id', $1, true)", [userId == null ? '' : String(userId)]);
    await tx.query("SELECT set_config('app.user_role', $1, true)", [role == null ? '' : String(role)]);
    return fn(tx);
  });
}

// The injected ctx — the IDENTICAL structured-ops surface worker-entry.ts exposes (list/insert/update/remove),
// backed by in-SW PGLite. identity = { userId, role } is bound by the dispatcher, NEVER the handler body — so
// the owner stamp + RLS scope key on the verified caller, exactly as on the run side. No raw-SQL op is exposed.
function __devMakeCtx(db, identity) {
  var userId = (identity && identity.userId != null) ? identity.userId : null;
  var role = (identity && identity.role != null) ? identity.role : null;
  return {
    // RLS scopes WHICH rows return (owner sees only theirs; public is world-readable); keyset by id when present.
    list: async function (table, opts) {
      opts = opts || {};
      var meta = await __devColumnsOf(db, table);
      var lim = Math.min(Math.max(1, Number(opts.limit) || 50), __DEV_MAX_LIMIT);
      var cursor = (opts.cursor == null) ? null : opts.cursor;
      var q = 'public."' + table + '"';
      return __devAsUser(db, userId, role, async function (tx) {
        var res;
        if (meta.hasId) {
          res = (cursor != null)
            ? await tx.query('SELECT * FROM ' + q + ' WHERE id > $1 ORDER BY id ASC LIMIT $2', [cursor, lim + 1])
            : await tx.query('SELECT * FROM ' + q + ' ORDER BY id ASC LIMIT $1', [lim + 1]);
        } else {
          res = await tx.query('SELECT * FROM ' + q + ' LIMIT $1', [lim + 1]);
        }
        var rawPage = res.rows.slice(0, lim);
        var last = rawPage[rawPage.length - 1];
        var nextCursor = (res.rows.length > lim && last && typeof last.id === 'number') ? last.id : null;
        // that phase per-field READ projection — mask owner-only / role-gated columns per row for a non-permitted
        // reader (the SAME masking the run side applies). id is read=all so it survives → nextCursor (from
        // the raw page above) is unaffected. Unruled tables (fields empty) pass through byte-identically.
        var rows = rawPage.map(function (r) { return __devProjectRowShape(r, meta, userId, role); });
        return { rows: rows, nextCursor: nextCursor };
      });
    },
    // The owner is STAMPED by the RLS DEFAULT (the GUC) — the owner column(s) are stripped from values so a
    // forged owner is overwritten, not honored (RLS WITH CHECK is the backstop). Returns the inserted row.
    insert: async function (table, values) {
      //  P1 honeypot (run parity): anon + filled '_hp' → silent drop.
      if (!userId) { var __hp = (values || {})['_hp']; if (typeof __hp === 'string' ? __hp.trim().length > 0 : (__hp != null && __hp !== false)) return null; }
      var meta = await __devColumnsOf(db, table);
      var strip = {};
      for (var k = 0; k < meta.owner.length; k++) strip[meta.owner[k]] = true;
      var entries = Object.entries(values || {}).filter(function (e) { return __devSafeIdent(e[0]) && meta.all.indexOf(e[0]) >= 0 && !strip[e[0]]; });
      //  (run parity) — a body whose EVERY field is unknown must not 201 an all-null row
      // (the miswired-form silent-data-loss shape). ≥1 supplied non-_hp key, zero touching a
      // declared column ⇒ loud 400 naming the unknowns (never echoing the schema). Empty body
      // stays legal (DEFAULT VALUES); partial matches keep drop-the-extras.
      var suppliedKeys = Object.keys(values || {}).filter(function (k2) { return k2 !== '_hp'; });
      if (suppliedKeys.length > 0) {
        var anyDeclared = false;
        for (var s1 = 0; s1 < suppliedKeys.length; s1++) { if (meta.all.indexOf(suppliedKeys[s1]) >= 0) { anyDeclared = true; break; } }
        if (!anyDeclared) {
          // Plain Error, message-shape-mapped to 400 by __dataMapError (the file's convention).
          throw new Error('unknown fields: ' + suppliedKeys.slice(0, 8).join(', ') + ' — no declared column matched; check the form\'s field names against the data model');
        }
      }
      // that phase/that phase write-gate (run parity, the parity harness): REJECT a withheld write — never
      // silently strip. A SIGNED-IN inserter owns the new row (owner DEFAULTs to their GUC) ⇒ isRowOwner
      // = true; an ANON insert stamps owner=NULL ⇒ isRowOwner = false, blocking owner-write fields (
      // run parity — no anon-set maker-only fields); admin-write needs the granted role; RLS backstop.
      __devRejectWithheldWrites(entries, meta, { isRowOwner: userId != null, isAdmin: role === 'admin' || role === 'trivial:maker' });
      __devAssertValueSizes(entries); //  P0b (run parity: runtime-api oversizedValue, 64KiB)
      var q = 'public."' + table + '"';
      // Run parity: an anonymous insert into an owner-scoped table stamps
      // owner=NULL — RETURNING would 42501 on the read-back. Fire-and-forget:
      // insert WITHOUT RETURNING, return null (a clean 201, no row).
      var anonToOwned = !userId && meta.owner.length > 0;
      return __devAsUser(db, userId, role, async function (tx) {
        var res;
        var cols = entries.map(function (e) { return '"' + e[0] + '"'; }).join(', ');
        var ph = entries.map(function (_e, i) { return '$' + (i + 1); }).join(', ');
        var params = entries.length ? entries.map(function (e) { return e[1]; }) : undefined;
        var insertSql = !entries.length
          ? 'INSERT INTO ' + q + ' DEFAULT VALUES'
          : 'INSERT INTO ' + q + ' (' + cols + ') VALUES (' + ph + ')';
        if (anonToOwned) { await tx.query(insertSql, params); return null; }
        //  (run parity) — the INSERT can be legal while the READ-BACK is not: the same
        // owner-NULL inbox, and now a visibleWhen table whose fresh row its inserter cannot see
        // (flag unset => hidden => RETURNING trips the SELECT policy). Savepoint + retry WITHOUT
        // RETURNING: a genuine WITH CHECK denial fails that too (same 403 as always); a legal
        // write lands as a clean 201 with no row.
        await tx.query('SAVEPOINT trivial_ins');
        try {
          res = await tx.query(insertSql + ' RETURNING *', params);
          await tx.query('RELEASE SAVEPOINT trivial_ins');
        } catch (insErr) {
          var msg = String((insErr && insErr.message) || insErr || '');
          var code = (insErr && insErr.code) || (msg.indexOf('row-level security') >= 0 ? '42501' : '');
          if (code !== '42501') throw insErr;
          await tx.query('ROLLBACK TO SAVEPOINT trivial_ins');
          await tx.query(insertSql, params);
          return null;
        }
        // The inserter OWNS the new row (owner DEFAULTs to their GUC) → owner-read fields are visible to them;
        // an admin-read field only if role==='admin'. Project the returned row the same as a read.
        var inserted = res.rows[0] || null;
        return inserted ? __devProjectRowShape(inserted, meta, userId, role) : null;
      });
    },
    // RLS USING scopes which rows you may touch; owner + id are stripped so ownership/PK can't be reassigned.
    // null ⇒ no row matched (missing or RLS-hidden).
    update: async function (table, id, values) {
      var meta = await __devColumnsOf(db, table);
      var strip = { id: true };
      for (var k = 0; k < meta.owner.length; k++) strip[meta.owner[k]] = true;
      var entries = Object.entries(values || {}).filter(function (e) { return __devSafeIdent(e[0]) && meta.all.indexOf(e[0]) >= 0 && !strip[e[0]]; });
      if (!entries.length) throw new Error('no updatable fields');
      __devAssertValueSizes(entries); //  P0b (run parity)
      // that phase/that phase write-gate (run parity, the parity harness) — needs the TARGET row's owner
      // (unlike insert): pre-read it RLS-scoped inside the SAME txn when any entry is non-'all'.
      // Not visible (RLS-hidden or missing) ⇒ null → 404, never revealing existence; visible but
      // withheld ⇒ throws (the 403 wire), loud, never a strip. Mirrors runtime-api.update.
      var isAdmin = role === 'admin' || role === 'trivial:maker'; //  run parity
      var needsGate = false;
      for (var g = 0; g < entries.length; g++) {
        var wrRule = meta.fields.get(entries[g][0]);
        if (((wrRule == null) ? 'all' : wrRule.write) !== 'all') { needsGate = true; break; }
      }
      var gateOwnerCol = __devOwnerColOf(meta);
      var q = 'public."' + table + '"';
      return __devAsUser(db, userId, role, async function (tx) {
        if (needsGate) {
          var tr = await tx.query('SELECT ' + (gateOwnerCol ? '"' + gateOwnerCol + '"' : 'NULL') + ' AS __owner FROM ' + q + ' WHERE id = $1', [__devCoerceId(id)]);
          if (!tr.rows.length) return null;
          var targetOwner = tr.rows[0].__owner;
          var isRowOwner = gateOwnerCol != null && userId != null && targetOwner != null && String(targetOwner) === String(userId);
          __devRejectWithheldWrites(entries, meta, { isRowOwner: isRowOwner, isAdmin: isAdmin });
        }
        var sets = entries.map(function (e, i) { return '"' + e[0] + '" = $' + (i + 1); }).join(', ');
        var params = entries.map(function (e) { return e[1]; });
        params.push(__devCoerceId(id));
        var res = await tx.query('UPDATE ' + q + ' SET ' + sets + ' WHERE id = $' + (entries.length + 1) + ' RETURNING *', params);
        // Project the returned row (READ masking) the same as a read — null ⇒ no row matched (RLS-hidden).
        var updated = res.rows[0] || null;
        return updated ? __devProjectRowShape(updated, meta, userId, role) : null;
      });
    },
    // RLS USING scopes the delete to rows you own. Returns whether a row was actually deleted.
    remove: async function (table, id) {
      if (!__devSafeIdent(table)) throw new Error('invalid table: ' + table);
      var q = 'public."' + table + '"';
      return __devAsUser(db, userId, role, async function (tx) {
        var res = await tx.query('DELETE FROM ' + q + ' WHERE id = $1 RETURNING id', [__devCoerceId(id)]);
        return res.rows.length > 0;
      });
    },
  };
}
// === end dev data core ========================================================================
`;

/**
 * The handler-tier runtime — ONLY the worker-entry shim now (the ctx machinery lives in
 * DEV_DATA_CORE_SOURCE above, spliced whenever pglite is on; handlers ⊂ pglite guarantees it is
 * present). Spliced at `// __DEV_HANDLER_RUNTIME__` under DYNAMIC_HANDLERS_ENABLED.
 */
export const DEV_HANDLER_RUNTIME_SOURCE = String.raw`
// === dev handler runtime — buildApp(ctx) over the in-SW PGLite ========================
// THE dev-side worker-entry shim — the EXACT two lines worker-entry.ts runs on the publish side
// (const app = buildApp(ctx); return app.fetch(req)), but ctx is PGLite-backed. So a byte-identical
// handlers/<route>.ts runs here unchanged. An uncaught handler error becomes a 500 (surfaced in the preview)
// rather than a rejected fetch the SW can't answer.
// an observation: the handler-log redaction seam. Design-ahead — NO secrets reach a dev
// handler today (isolate bindings are PROJECT_ID + GATEWAY_URL only), so this is
// identity for now; when a per-project secret store lands, scrub known secret
// values HERE, before any line leaves the SW.
function __redactHandlerLog(s) { return s; }
// an observation: ship this request's captured handler console to the shell, which
// relays it to the SPA as a kind:'handler' runtime signal (ring + prompt + the
// inspect_handler_logs tool). SW→client postMessage; the shell keys it by conv.
function __emitHandlerLogs(route, status, entries) {
  try {
    self.clients.matchAll({ includeUncontrolled: true }).then(function (cs) {
      var msg = { type: 'trivial:handler-log', route: route, status: status, entries: entries, ts: Date.now() };
      for (var i = 0; i < cs.length; i++) { try { cs[i].postMessage(msg); } catch (_e) {} }
    });
  } catch (_e) {}
}
async function __devRunHandler(o) {
  var ctx = __devMakeCtx(o.db, o.identity || {});
  var app = o.buildApp(ctx);
  // an observation: capture THIS request's handler console (the server-side blind spot).
  var __logs = [];
  var __orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  var __mk = function (level) { return function () {
    try {
      var parts = Array.prototype.map.call(arguments, function (a) {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (_e) { return String(a); }
      });
      __logs.push({ level: level, message: __redactHandlerLog(parts.join(' ')).slice(0, 500) });
    } catch (_e) {}
    try { __orig[level].apply(console, arguments); } catch (_e) {}
  }; };
  console.log = __mk('log'); console.warn = __mk('warn'); console.error = __mk('error'); console.info = __mk('info');
  var __status = 0;
  try {
    var __res = await app.fetch(o.request, {});
    __status = __res.status;
    return __res;
  } catch (e) {
    __logs.push({ level: 'error', message: __redactHandlerLog('uncaught: ' + String((e && e.stack) || (e && e.message) || e)).slice(0, 500) });
    __status = 500;
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  } finally {
    console.log = __orig.log; console.warn = __orig.warn; console.error = __orig.error; console.info = __orig.info;
    if (__logs.length) __emitHandlerLogs(o.route || '', __status, __logs);
  }
}
// === end dev handler runtime =================================================================
`;

/**
 * Load the curated-deps resolver MAP — `{ specifier: assetUrl }` for each pre-bundled curated dep, derived
 * from the committed `static/iframe-runtime/curated-deps/manifest.json` (built by
 * `scripts/build-curated-deps.sh`). The `?v=<hash>` busts the immutable static cache on a dep bump. Read at
 * SW-assembly (server-side) so the SW carries a baked, static map — ZERO serve-time compute, and the SW
 * realm (which has no import map) needs no manifest fetch. Defensive: a missing/garbled manifest yields an
 * EMPTY map (curated imports then won't resolve in dev — handlers with imports fail to load with a clear
 * error — but SW assembly never breaks, so flag-off stays inert). BOUNDED: only the fixed allowlist appears.
 */
function loadCuratedDepsMap(): Record<string, string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = resolvePath(here, '../static/iframe-runtime/curated-deps/manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, { version?: string; hash?: string }>;
    const map: Record<string, string> = {};
    for (const [name, info] of Object.entries(raw)) {
      if (name.startsWith('_') || !info || typeof info !== 'object' || !info.hash) continue; // skip _comment / malformed
      map[name] = `/api/iframe-runtime/curated-deps/${name}.js?v=${info.hash}`;
    }
    return map;
  } catch {
    return {}; // fail-INERT (never break SW assembly); build the bundles via scripts/build-curated-deps.sh
  }
}

const CURATED_DEPS_MAP = loadCuratedDepsMap();

/**
 * The curated-deps RESOLVER (that phase follow-up — the deps→SW bridge). Spliced into the SW between the runtime
 * and the dispatch. `__DEV_CURATED_DEPS` is the baked map (a plain JSON object literal — no `${`/backticks, so
 * the function-form splice can't mangle it); `__devResolveCuratedImports` rewrites a handler's BARE curated
 * import specifiers (`'hono'`, …) to the pre-bundled worker-ESM asset URLs, AST-level, the SAME
 * mutate-`litNode.value/raw` pattern `rewriteImports` uses (so only real import/export SOURCES are rewritten,
 * never a matching string literal elsewhere). Curated-ONLY: a specifier with no mapping (a non-allowlisted
 * dep, or a curated SUBPATH we don't pre-bundle) is LEFT BARE → the blob-import throws a clear "Failed to
 * resolve module specifier", surfaced as the handler load error (the desired fail for a non-allowlisted dep;
 * the publish guardrail blocks it too). Authored so `loadDevRuntime()` can instantiate + expose it for tests.
 */
export const DEV_CURATED_RESOLVER_SOURCE =
  '\n// === curated-deps resolver — the deps→SW bridge =============================\n' +
  'var __DEV_CURATED_DEPS = ' + JSON.stringify(CURATED_DEPS_MAP) + ';\n' +
  CURATED_RESOLVER_FN_SOURCE();

function CURATED_RESOLVER_FN_SOURCE(): string {
  return String.raw`
// Rewrite the handler's BARE curated import specifiers to the pre-bundled asset URLs. A specifier with no
// mapping is left untouched (a non-allowlisted dep or an un-prebundled curated subpath → fails at blob-import,
// the desired behavior). hasOwnProperty so an import of e.g. 'constructor' can't match an Object proto key.
function __devResolveCuratedImports(ast) {
  var targets = [];
  function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration' && node.source && node.source.type === 'StringLiteral') targets.push(node.source);
    else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source && node.source.type === 'StringLiteral') targets.push(node.source);
    else if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Import') {
      var arg = node.arguments && node.arguments[0];
      var expr = arg && arg.expression;
      if (expr && expr.type === 'StringLiteral') targets.push(expr);
    }
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'span' || k === 'type' || k === '__source') continue;
      var v = node[k];
      if (Array.isArray(v)) { for (var j = 0; j < v.length; j++) collect(v[j]); }
      else if (v && typeof v === 'object') collect(v);
    }
  }
  collect(ast);
  for (var t = 0; t < targets.length; t++) {
    var lit = targets[t];
    var url = Object.prototype.hasOwnProperty.call(__DEV_CURATED_DEPS, lit.value) ? __DEV_CURATED_DEPS[lit.value] : null;
    if (url) { lit.value = url; lit.raw = JSON.stringify(url); }
  }
}
// === end curated-deps resolver ===============================================================
`;
}

/**
 * The dev DISPATCH body (spliced into the SW right after the runtime, at the `// __DEV_HANDLER_RUNTIME__`
 * marker). The dev analog of the publish dispatcher (`handler-dispatch.ts`): the SW intercepts the preview
 * app's `/api/<route>` calls, resolves the route to a project handler (`handlers/<route>.<ext>` — the dev
 * "registry" is the filesystem, via `probeExists`), transforms it with the SW's swc, and runs it against the
 * in-SW PGLite. A non-handler `/api/<route>` PASSES THROUGH to the network (byte-identical to today).
 * References SW-scope helpers defined in `sw-source.ts` (`fetchUpstream` / `probeExists` / `transformSync` /
 * `parseSync` / `ensureSwcInit` / `swcReady` / `swEvent`) and `pglite-substrate.ts` (`__pgliteGetDb`) — all
 * present because `handlers` is nested under `pglite` (the server flag `DYNAMIC_HANDLERS_ENABLED` requires
 * `DYNAMIC_APPS_ENABLED`).
 *
 * DEPS→SW BRIDGE (that phase follow-up — DONE): a handler that imports a BARE curated dep (`import { Hono } from
 * 'hono'`) now RUNS here — `__devResolveCuratedImports` (above) rewrites the bare curated specifiers to the
 * pre-bundled worker-ESM asset URLs (`/api/iframe-runtime/curated-deps/<dep>.js`) before the blob-import, so
 * the SW (which has no import map) resolves them. Curated-ONLY: a non-allowlisted dep has no mapping → left
 * bare → fails at import with a clear error (matching the publish guardrail's refusal). REMAINING (flagged):
 * curated SUBPATHS (`hono/cors`, `drizzle-orm/pg-core`) aren't pre-bundled — they surface the same clear
 * "Failed to resolve module specifier" in the dev preview but DO work on publish (esbuild bundles them); and
 * a multi-file handler's relative imports (`./util`) aren't resolved here (single-file handlers in dev). The
 * live-browser e2e is the gold-standard remainder; the deps-resolved load+run is proven at the component
 * level (`validate-dev-handler-runtime.ts` Part F — the real curated bundle).
 */

/**
 * The RESOLUTION half of the handler dispatch — Service Worker only.
 *
 * Every function here needs a capability a dedicated Worker does not have: swc-wasm to transform
 * TypeScript, `fetchUpstream` to fetch project source with the `?st=` token, and
 * `self.registration.scope` to resolve paths. That is why the split falls here and not somewhere
 * tidier — it follows the capabilities.
 *
 * Kept OUT of the worker deliberately. Splicing it there would put an authenticated fetch and a
 * 22MB wasm dependency into a thread that needs neither, and leave functions referencing globals
 * that do not exist — a ReferenceError waiting for the first caller.
 */
export const DEV_HANDLER_RESOLVE_SOURCE = String.raw`
// === dev handler resolution (SW-only) ========================================================
var __DEV_RESERVED = {};
['data','public','internal','projects','sites','spaces','space','auth','login','logout','register','me',
 'csrf','refresh','token','feedback','health','healthz','metrics','status','direct-shares','s','users',
 'billing','stripe','webhooks','admin','iframe-runtime','iframe','ws'].forEach(function (k) { __DEV_RESERVED[k] = true; });

var __DEV_HANDLER_EXTS = ['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts'];
// The URL test lives here too: the Service Worker decides which /api/<route> is a handler, and
// that decision needs no database — only the reserved-prefix list.
function __devIsHandlerCandidate(url) {
  try {
    if (url.origin !== self.location.origin) return false;
    var scopePath = new URL('./', self.registration.scope).pathname; // /api/spaces/<sid>/projects/<slug>/iframe/
    if (url.pathname.indexOf(scopePath) === 0) return false;         // an iframe-scope control/source path
    var m = /^\/api\/([^/?#]+)/.exec(url.pathname);
    if (!m) return false;
    var seg = m[1].toLowerCase();
    if (__DEV_RESERVED[seg]) return false;
    return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(seg);
  } catch (e) { return false; }
}

function __devToCjs(source, isTs, filename) {
  var ast = parseSync(source, { syntax: isTs ? 'typescript' : 'ecmascript', tsx: false, target: 'es2022' });
  ast.__source = source;
  __devResolveCuratedImports(ast); // bare curated specifiers → same-origin asset URLs (the require keys)
  var out = transformSync(ast, {
    filename: filename,
    jsc: { parser: { syntax: isTs ? 'typescript' : 'ecmascript', tsx: false }, target: 'es2022', loose: false },
    module: { type: 'commonjs' }, isModule: true,
  });
  return (out && out.code) || '';
}

function __devCollectRequires(cjs) {
  var urls = [], re = /require\(\s*["']([^"']+)["']\s*\)/g, m;
  while ((m = re.exec(cjs)) !== null) { if (urls.indexOf(m[1]) < 0) urls.push(m[1]); }
  return urls;
}







/**
 * Resolve a handler to compiled CommonJS WITHOUT running it.
 *
 * Identical fetching and transforming to __devLoadHandler — same sources, same swc call, same
 * recursion over requires — but it returns the bytes instead of evaluating them, so the host that
 * owns the database can do the evaluating. Returns null when no handler file exists, which the
 * caller must treat exactly as __devLoadHandler's null: pass through to the network.
 */
async function __devCollectDep(url, out, seen) {
  if (seen[url]) return;
  seen[url] = true;
  var resp = await fetchUpstream(url, { credentials: 'include', cache: 'no-store' });
  if (!resp.ok) throw new Error('dev handler dep fetch failed (' + resp.status + '): ' + url);
  var cjs = __devToCjs(await resp.text(), false, url);
  var reqs = __devCollectRequires(cjs);
  for (var i = 0; i < reqs.length; i++) { if (reqs[i] !== url) await __devCollectDep(reqs[i], out, seen); }
  // Depth-first: a dep is pushed only after the deps it requires, so the far side can run the list
  // in order with a require() that only ever looks backwards.
  out.push({ url: url, cjs: cjs });
}

async function __devCollectBundle(route) {
  ensureSwcInit();
  await swcReady;
  for (var i = 0; i < __DEV_HANDLER_EXTS.length; i++) {
    var absRel = 'handlers/' + route + __DEV_HANDLER_EXTS[i];
    if (!(await probeExists(absRel))) continue;
    var srcUrl = new URL('source/' + absRel, self.registration.scope).href;
    var resp = await fetchUpstream(srcUrl, { credentials: 'include', cache: 'no-store' });
    if (!resp.ok) continue;
    var source = await resp.text();
    var isTs = /\.(ts|mts|cts)$/.test(absRel);
    var mainCjs = __devToCjs(source, isTs, '/iframe/source/' + absRel);
    var deps = [], seen = {};
    var reqs = __devCollectRequires(mainCjs);
    for (var j = 0; j < reqs.length; j++) await __devCollectDep(reqs[j], deps, seen);
    return { route: route, mainCjs: mainCjs, deps: deps };
  }
  return null;
}
// === end dev handler resolution ==============================================================
`;

/**
 * The fetch-and-RUN load path — Service Worker, and only when it hosts the database itself
 *.
 *
 * It needs both halves at once: `fetchUpstream` and swc to get the code, and `__devRunCjs` to run
 * it. That combination exists in exactly one place — the Service Worker on the pre-host transport.
 * With the data host on, the worker collects compiled bytes instead (`__devCollectBundle`) and the
 * side with the database runs them, so this is not spliced at all and `__devDispatch` takes the
 * pre-built app.
 */
export const DEV_HANDLER_LOAD_SOURCE = String.raw`
// === dev handler load path (SW, non-host only) ===============================================
async function __devLoadCjsDep(url) {
  if (Object.prototype.hasOwnProperty.call(__devModCache, url)) return __devModCache[url];
  var resp = await fetchUpstream(url, { credentials: 'include', cache: 'no-store' });
  if (!resp.ok) throw new Error('dev handler dep fetch failed (' + resp.status + '): ' + url);
  var cjs = __devToCjs(await resp.text(), false, url); // curated dep assets are plain JS
  var reqs = __devCollectRequires(cjs);
  for (var i = 0; i < reqs.length; i++) { if (reqs[i] !== url) await __devLoadCjsDep(reqs[i]); }
  return __devRunCjs(cjs, url);
}

async function __devEvalCjs(source, isTs, filename) {
  var cjs = __devToCjs(source, isTs, filename);
  var reqs = __devCollectRequires(cjs);
  for (var i = 0; i < reqs.length; i++) await __devLoadCjsDep(reqs[i]);
  return __devRunCjs(cjs, null); // the handler module itself is per-load, not cached
}

async function __devLoadHandler(route) {
  ensureSwcInit();
  await swcReady;
  for (var i = 0; i < __DEV_HANDLER_EXTS.length; i++) {
    var absRel = 'handlers/' + route + __DEV_HANDLER_EXTS[i];
    if (!(await probeExists(absRel))) continue;
    var srcUrl = new URL('source/' + absRel, self.registration.scope).href;
    var resp = await fetchUpstream(srcUrl, { credentials: 'include', cache: 'no-store' });
    if (!resp.ok) continue;
    var source = await resp.text();
    var isTs = /\.(ts|mts|cts)$/.test(absRel);
    // SW-safe load — CommonJS + new Function (no import, no createObjectURL).
    var moduleExports = await __devEvalCjs(source, isTs, '/iframe/source/' + absRel);
    var buildApp = moduleExports && moduleExports.buildApp;
    if (typeof buildApp !== 'function') throw new Error('handlers/' + route + ' must export a function buildApp(ctx)');
    return buildApp;
  }
  return null;
}
// === end dev handler load path ===============================================================
`;

export const DEV_HANDLER_DISPATCH_SOURCE = String.raw`
// === dev handler dispatch — the SW intercepts /api/<route> in the preview =============
// The LOAD path (fetch-and-run) lives here with __devRunCjs and __devModCache, which it needs.
// The resolver next door only COLLECTS compiled bytes, so it can be spliced into a worker that
// has no database and no business running anything.






// First path-segments a dev handler may NEVER claim: the publish reserved set (handler-dispatch.ts) PLUS the
// dev-only canvas-runtime control prefixes (the iframe shell + its assets live on api.trivial.so, unlike a
// published <handle>.trivial.build host where /api is the handler's alone).

// Is THIS request a candidate dev-handler request? Sync + cheap (no probe/manifest). The app's /api/<route>
// calls are ROOT-absolute; the SW's own source/manifest/asset fetches live under the iframe scope
// (/api/spaces/.../iframe/...) and a candidate must be OUTSIDE it + a non-reserved single safe route ident.

// Resolve + load handlers/<route>.<ext> → the user's buildApp(ctx); null when no such handler exists (the dev
// registry IS the filesystem). Transform via the SW's swc (the same engine source modules ride), then load the
// module to read its buildApp export. (Import resolution is the flagged remainder — see the jsdoc above.)
// a tiny CommonJS module loader for the SW. The SW FORBIDS dynamic import (w3c/ServiceWorker)
// and has no URL.createObjectURL, so a transformed ESM module cannot be import()'d here at all. Instead we
// transform to CommonJS (swc) and run it through new Function — permitted, since the SW carries NO CSP (the
// same permission WASM/swc already ride). Curated deps are pre-bundled single-file ESM served same-origin, so
// a require is resolved by pre-fetching + transforming + caching each dep first (recursion- + cycle-safe); the
// handler's SYNC require() then reads that cache. This keeps the handler running IN the SW (data path
// unchanged) — no client-forwarding, no server bundle.
var __devModCache = {};


function __devRunCjs(cjs, cacheKey) {
  var moduleObj = { exports: {} };
  if (cacheKey) __devModCache[cacheKey] = moduleObj.exports; // cache BEFORE run — cycle-safe (partial exports)
  var requireFn = function (spec) {
    if (Object.prototype.hasOwnProperty.call(__devModCache, spec)) return __devModCache[spec];
    throw new Error('dev handler: dependency not preloaded: ' + spec);
  };
  var fn = new Function('require', 'module', 'exports', cjs);
  fn(requireFn, moduleObj, moduleObj.exports);
  if (cacheKey) __devModCache[cacheKey] = moduleObj.exports;
  return moduleObj.exports;
}




// THE dev dispatch entrypoint — called from the fetch handler for candidate /api/<route> requests. Loads + runs
// the handler against the in-SW PGLite, or PASSES THROUGH to the network when no handler is declared (unchanged
// behavior for a non-handler /api/<route>). Identity is the dev preview's mock end-user, resolved in order:
// an explicit x-trivial-as-user / x-trivial-as-role header wins (the e2e/harness per-request escape hatch),
// else the SW-scope view-as (__pgliteViewAs — the preview-identity wire: the canvas identity picker, posted
// via trivial:set-identity, which the app's OWN fetch('/api/<route>') calls can't carry as headers), default
// anonymous. So alice ⊥ bob is provable in the browser from the picker alone.




/** Run a bundle collected by __devCollectBundle. Pure evaluation — no fetching, no swc. */
// Compiled handler modules, keyed by route and validated against the compiled text. Text
// equality is the whole invalidation story: the maker edits the handler, the Service Worker
// recompiles, the bytes differ, the cache misses. No versions to keep in sync.
var __devBundleApps = {};

function __devRunBundle(bundle) {
  // Deps are evaluated ONCE. __devRunCjs has no early cache return — it always builds a new
  // Function and executes it — and on the pre-host transport that was fine, because
  // __devLoadCjsDep checked the cache before ever calling it. This path called __devRunCjs
  // directly, so every dependency was recompiled and re-executed on EVERY request: for a Hono
  // handler, the entire framework, per call. That is where 's +67ms lived.
  for (var i = 0; i < bundle.deps.length; i++) {
    var dep = bundle.deps[i];
    if (Object.prototype.hasOwnProperty.call(__devModCache, dep.url)) continue;
    __devRunCjs(dep.cjs, dep.url);
  }

  var hit = __devBundleApps[bundle.route];
  if (hit && hit.mainCjs === bundle.mainCjs) return hit.buildApp;

  var moduleExports = __devRunCjs(bundle.mainCjs, null);
  var buildApp = moduleExports && moduleExports.buildApp;
  if (typeof buildApp !== 'function') throw new Error('handlers/' + bundle.route + ' must export a function buildApp(ctx)');
  __devBundleApps[bundle.route] = { mainCjs: bundle.mainCjs, buildApp: buildApp };
  return buildApp;
}

async function __devDispatch(request, url, preloadedBuildApp, viewAs) {
  var m = /^\/api\/([^/?#]+)/.exec(url.pathname);
  var route = m ? m[1].toLowerCase() : '';
  var buildApp = null;
  try {
    // the two halves of a handler live in different hosts now. RESOLUTION needs
    // swc, the ?st= token and the worker scope — Service Worker things. EXECUTION needs a PGlite —
    // which on WebKit only the dedicated worker has. So the SW resolves and compiles, ships the
    // result here, and this side only runs it. Passing the built app in is the whole seam.
    if (preloadedBuildApp) buildApp = preloadedBuildApp;
    else if (typeof __devLoadHandler === 'function') buildApp = await __devLoadHandler(route);
    else throw new Error('this host cannot resolve handlers — a compiled bundle was expected');
  } catch (e) {
    swEvent({ step: 'transform', level: 'error', message: 'dev handler load failed (/api/' + route + '): ' + ((e && e.message) || e) });
    return new Response(JSON.stringify({ error: 'handler load failed: ' + ((e && e.message) || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  if (!buildApp) return fetch(request); // not a declared handler → passthrough (byte-identical to today)
  var db = await __pgliteGetDb();
  // typeof-guarded belt-and-braces (matches the fetch-branch style): __pgliteViewAs lives in the pglite
  // substrate splice, which is structurally present whenever handlers are (the flags nest) — but a
  // missing var must degrade to today's header-or-anonymous, never throw. '' (anon) is preserved.
  // viewAs passed by the caller wins: in the data host one worker serves several tabs, each of which
  // may be previewing as a different person, so the identity has to travel WITH the request rather
  // than sit in a global the next tab overwrites. In the Service Worker nothing passes it and the
  // frame's own global is the only identity there is.
  var __viewAs = viewAs || ((typeof __pgliteViewAs !== 'undefined' && __pgliteViewAs) ? __pgliteViewAs : { userId: null, role: null });
  var identity = {
    userId: request.headers.get('x-trivial-as-user') || __viewAs.userId,
    role: request.headers.get('x-trivial-as-role') || __viewAs.role,
  };
  swEvent({ step: 'transform', level: 'dim', message: 'dev handler /api/' + route + ' → in-SW PGLite' });
  var resp = await __devRunHandler({ db: db, buildApp: buildApp, request: request, identity: identity, route: route });
  //  — the remedial-preview wire, handler plane: a 403 from the app's own route while the
  // identity is anonymous (owner-default scopes as anon here — this plane has no sees-all) is the
  // "you acted signed-out" moment. The emitter lives in the pglite splice (structurally present
  // whenever handlers are — the flags nest); typeof-guarded like every cross-splice reference.
  try {
    if (resp && resp.status === 403 && typeof __emitPreviewRemedy === 'function') {
      __emitPreviewRemedy(identity, route, 'refused-write');
    }
  } catch (eR) { /* the teaching wire never breaks dispatch */ }
  return resp;
}
// === end dev handler dispatch ================================================================
`;

/**
 * The fetch-handler BRANCH (spliced at the `// __DEV_HANDLER_FETCH_BRANCH__` marker inside the SW's existing
 * fetch listener). Gated by the same `handlers` flag, so flag-off ⇒ this is empty ⇒ the fetch handler is
 * byte-identical. The `typeof` guard is belt-and-braces (the function exists only when the dispatch is spliced).
 */
/**
 * The handler branch for the data-host transport.
 *
 * The Service Worker resolves and compiles the handler HERE — it is the only host with swc, the
 * `?st=` token and the registration scope — then relays the compiled bundle with the request to
 * the worker, which is the only host with a PGlite to run it against. Split by capability, not by
 * preference.
 *
 * A route with no handler file collects to null and falls through to the network, exactly as the
 * in-worker path does, so a non-handler /api/<route> is unaffected.
 */
export const DEV_HANDLER_FETCH_BRANCH_HOST_SOURCE =
  "if (typeof __devIsHandlerCandidate === 'function' && __devIsHandlerCandidate(url)) { event.respondWith(__devViaHost(event.request, url, event.clientId)); return; }";

/** The collect-then-relay wrapper, spliced alongside the branch above. */
export const DEV_HANDLER_HOST_RELAY_SOURCE = String.raw`
// === handler relay to the data host  =======================================
async function __devViaHost(request, url, clientId) {
  // Same rule as the /api/data relay: a seat with no Local data of its own reads Live, and Live
  // handlers run on the server. Going to the network here also skips the compile, which is the
  // right outcome — there is no local database for a compiled handler to run against.
  if (typeof __dataPlane !== 'undefined' && __dataPlane === 'live') return fetch(request);
  var m = /^\/api\/([^/?#]+)/.exec(url.pathname);
  var route = m ? m[1].toLowerCase() : '';
  var bundle = null;
  try {
    bundle = await __devCollectBundle(route);
  } catch (e) {
    swEvent({ step: 'transform', level: 'error', message: 'handler compile failed for /api/' + route + ': ' + ((e && e.message) || e) });
    return new Response(JSON.stringify({ error: 'handler failed to compile: ' + ((e && e.message) || String(e)) }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
  // No handler file: pass through to the network, the same as the non-relayed path. Getting this
  // wrong would turn every ordinary /api/<route> in the preview into a 404.
  if (!bundle) return fetch(request);
  return __dataViaHost(request, url, bundle, clientId);
}
// === end handler relay =======================================================================
`;

export const DEV_HANDLER_FETCH_BRANCH_SOURCE =
  "if (typeof __devIsHandlerCandidate === 'function' && __devIsHandlerCandidate(url)) { event.respondWith(__devDispatch(event.request, url)); return; }";

/** Identity bound by the dispatcher (the verified end-user, or the dev mock) — never the handler body. */
export interface DevIdentity {
  userId: string | null;
  role: string | null;
}

/** The PGLite-backed structured ops — the IDENTICAL surface `worker-entry.ts` exposes on the publish side. */
export interface DevCtx {
  list(table: string, opts?: { cursor?: number | null; limit?: number }): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: number | null }>;
  insert(table: string, values: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  update(table: string, id: string | number, values: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  remove(table: string, id: string | number): Promise<boolean>;
}

/** A handler-shaped app: `buildApp(ctx)` returns something with a Hono-style `fetch(req, env?)`. */
export interface HandlerApp {
  fetch(request: unknown, env?: unknown): Promise<unknown> | unknown;
}

/** A parsed per-field rule, as the dev mirror returns it (plain strings; the run side's closed FieldAxis). */
export interface DevFieldRule { read: string; write: string; }
/** The dev column metadata the projection reads — owner cols (array) + the per-field rule Map. */
export interface DevColMeta { all: string[]; owner: string[]; hasId: boolean; fields: Map<string, DevFieldRule>; }

/** The runtime surface — the functions defined in `DEV_HANDLER_RUNTIME_SOURCE`, exposed for node tests/reuse. */
export interface DevRuntime {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  __devSafeIdent(name: unknown): boolean;
  __devCoerceId(id: string | number): string | number;
  __devColumnsOf(db: any, table: string): Promise<DevColMeta>;
  __devAsUser<T>(db: any, userId: string | null, role: string | null, fn: (tx: any) => Promise<T>): Promise<T>;
  __devMakeCtx(db: any, identity: DevIdentity): DevCtx;
  __devRunHandler(o: { db: any; buildApp: (ctx: DevCtx) => HandlerApp; request: unknown; identity?: DevIdentity }): Promise<unknown>;
  // that phase per-field READ projection mirror (parity-pinned to field-projection.ts) — exposed for the test.
  __devParseFieldRule(comment: string | null | undefined): DevFieldRule | null;
  __devOwnerColOf(meta: { owner: string[] }): string | null;
  __devIsColumnReadable(rule: DevFieldRule | null | undefined, ctx: { isRowOwner: boolean; isAdmin: boolean }): boolean;
  // that phase/that phase write-gate mirror (the parity harness; parity-pinned to field-projection.ts).
  __devIsColumnWritable(rule: DevFieldRule | null | undefined, ctx: { isRowOwner: boolean; isAdmin: boolean }): boolean;
  __devRejectWithheldWrites(entries: Array<[string, unknown]>, meta: DevColMeta, ctx: { isRowOwner: boolean; isAdmin: boolean }): void;
  __devProjectRowShape(row: Record<string, unknown>, meta: DevColMeta, userId: string | null, role: string | null): Record<string, unknown>;
  // that phase deps→SW bridge — the curated-import resolver + the baked map, exposed for the resolver test.
  __devResolveCuratedImports(ast: unknown): void;
  __DEV_CURATED_DEPS: Record<string, string>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Instantiate the runtime from the SAME bytes the SW splices — so a test runs the EXACT code that ships, not
 * a parallel impl. `new Function` (not import) because the source is authored as the SW-splice string (it has
 * no module imports; it operates on the injected `db`). Used by `__tests__/dev-handler-runtime.test.ts`.
 */
export function loadDevRuntime(): DevRuntime {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(
    DEV_DATA_CORE_SOURCE + DEV_HANDLER_RUNTIME_SOURCE + DEV_CURATED_RESOLVER_SOURCE +
      '\nreturn { __devSafeIdent, __devCoerceId, __devColumnsOf, __devAsUser, __devMakeCtx, __devRunHandler,' +
      ' __devParseFieldRule, __devOwnerColOf, __devIsColumnReadable, __devIsColumnWritable,' +
      ' __devRejectWithheldWrites, __devProjectRowShape,' +
      ' __devResolveCuratedImports, __DEV_CURATED_DEPS };',
  );
  return factory() as DevRuntime;
}
