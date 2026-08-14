/**
 * The host-agnostic half of the PGLite build-data substrate (Phase 0).
 *
 * WHY THIS FILE EXISTS: PGlite will not instantiate in a Service Worker registered from an embedded
 * frame on WebKit, so the database has to move to a
 * host that works — a dedicated Worker owned by the frame. Nothing here knows it lives in a Service
 * Worker; the SW-shaped half (the `message` listener, `event.source`, `event.waitUntil`) stays in
 * pglite-substrate.ts, and a second host can splice THIS string with a bridge of its own.
 *
 * Phase 0 is a MOVE, not a rewrite: `PGLITE_SUBSTRATE_SOURCE` is now this string concatenated with
 * the bridge, and the emitted Service Worker is byte-identical (asserted in
 * __tests__/pglite-host-seam.test.ts). Nothing changes behaviour until a host is added.
 *
 * THE HOST CONTRACT — a host splicing this string must provide, in scope:
 *   - `PGlite`         the constructor (see PGLITE_IMPORT_SOURCE)
 *   - `swEvent(evt)`   an event sink taking { step, level, message }. Named for the Service Worker
 *                      because renaming it would change the emitted bytes; Phase 1 can rename it
 *                      once byte-identity has served its purpose.
 *   - `getManifest()`  resolves the project manifest (supplies the compiled dataSchema)
 *   - `indexedDB`, `fetch`, `WebAssembly`  — standard, present in every intended host
 *   - `self.location.pathname` containing `/spaces/<id>/projects/<slug>/`
 *
 * That last one is the single genuinely host-coupled line (`__pgliteIdbName`): in a dedicated
 * Worker `self.location` is the worker script's URL, which carries no space or slug. Phase 1 makes
 * the datadir name injected rather than derived. It is left alone here on purpose — changing it
 * would change the emitted bytes, which is exactly what this phase promises not to do.
 */

export const PGLITE_CORE_SOURCE = `
// === PGLite build-data substrate — gated on DYNAMIC_APPS_ENABLED ====================
// No-manifest fallback: EMPTY — no tables, no RLS. Only the app_user role is ensured so the
// connection discipline (SET LOCAL ROLE app_user — handler dispatch, identity-scoped reads) never
// dies on a missing role; with zero tables and zero grants it can read/write nothing.
var PGLITE_EMPTY_GRANTS = "DO $$ BEGIN CREATE ROLE app_user NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;";
// How long ONE caller waits before reporting "still starting". Non-destructive: the boot
// it was waiting on keeps running and the next caller joins it — see __pgliteGetDb.
var PGLITE_BOOT_TIMEOUT_MS = 15000;
// The hard ceiling on a single boot attempt. Only when THIS is exceeded is the shared boot
// abandoned so a genuinely fresh attempt can start; without it, one wedged create() would make
// every future call time out forever with no way back.
var PGLITE_BOOT_CEILING_MS = 60000;

// The per-project IndexedDB handle — unique per project, shared by the app's runtime queries and
// the Data app's reads, and IDENTICAL in the Service Worker and the data-host worker (a divergence
// there means the two transports read different databases and the flag flip loses the maker's rows).
//
// The key is the project's IMMUTABLE id, injected by the server as __TRIVIAL_DATADIR_KEY.
//
// It used to be derived from this worker's own path — spaceId + SLUG. A slug is renameable
// (PATCH /api/projects/:id takes one), and nothing migrates an IndexedDB database, so renaming a
// project silently pointed PGlite at a name that had never existed: a fresh empty database, every
// draft row unreachable, the old datadir orphaned in IndexedDB forever. The maker renamed their
// project and their data was gone, with no error anywhere.
//
// Injected rather than page-supplied on purpose. Every frame shares one origin, so a key the page
// could name is a key one project's frame could use to open ANOTHER project's Local data. Deriving
// from self.location was tamper-proof for exactly that reason; a server-side splice keeps the
// property while dropping the mutable half.
function __pgliteIdbName() {
  var injected = (typeof __TRIVIAL_DATADIR_KEY !== 'undefined' && __TRIVIAL_DATADIR_KEY) ? __TRIVIAL_DATADIR_KEY : '';
  // The fallback is the pre-rename-fix derivation, kept for hosts that splice the core without a
  // key (the node data plane, the artifact verifier). It is wrong under rename and cannot be right:
  // a path that carries no project id has nothing immutable in it.
  if (!injected) {
    var m = String(self.location && self.location.pathname || '').match(/\\/spaces\\/([^/]+)\\/projects\\/([^/]+)\\//);
    injected = m ? (m[1] + '_' + m[2]) : 'unknown';
  }
  return 'idb://trivial-build-' + String(injected).replace(/[^a-zA-Z0-9_-]/g, '');
}

// the datadir that can never repair itself.
//
// PGlite persists through Emscripten's IDBFS: one IndexedDB database per datadir, mounted at
// /pglite/<name>, holding a single object store FILE_DATA created in onupgradeneeded at
// DB_VERSION 21. That upgrade fires ONLY when the stored version is below 21 — so a database
// sitting AT v21 with no FILE_DATA store is terminal: every open succeeds, no upgrade ever runs,
// the store is never recreated, and every transaction throws NotFoundError ("The object can not be
// found here." in WebKit's older wording, which is what the maker reads). Retrying cannot fix it;
// only deleting the database can. A boot interrupted between the open and the store's first write
// — a jetsammed tab on a memory-tight iPad, a killed worker, a dev-server reload, or two PGlites
// racing the same datadir (the bug fixed below) — leaves exactly that.
//
// So: inspect BEFORE handing the datadir to PGlite, while nothing holds a connection. Once
// PGlite.create has failed, its own handle blocks deleteDatabase, and repair needs a reload.
function __pgliteIdbDbName() { return '/pglite/' + __pgliteIdbName().replace('idb://', ''); }

function __pgliteProbeDatadir(dbName) {
  // Opens WITHOUT a version so it can never trigger an upgrade of its own, and closes immediately
  // so the handle can't block the delete that may follow.
  return new Promise(function (resolve) {
    var req;
    try { req = indexedDB.open(dbName); } catch (e) { return resolve(null); }
    var settled = false;
    var finish = function (v) { if (!settled) { settled = true; resolve(v); } };
    req.onsuccess = function () {
      var db = req.result;
      var names = [];
      var version = 0;
      try {
        version = db.version || 0;
        for (var i = 0; i < db.objectStoreNames.length; i++) names.push(db.objectStoreNames[i]);
      } catch (e) { /* noop */ }
      try { db.close(); } catch (e) { /* noop */ }
      finish({ version: version, stores: names });
    };
    req.onerror = function () { finish(null); };
    req.onblocked = function () { finish(null); };
    setTimeout(function () { finish(null); }, 5000);
  });
}

function __pgliteDeleteDatadir(dbName) {
  return new Promise(function (resolve) {
    var req;
    try { req = indexedDB.deleteDatabase(dbName); } catch (e) { return resolve(false); }
    var settled = false;
    var finish = function (v) { if (!settled) { settled = true; resolve(v); } };
    req.onsuccess = function () { finish(true); };
    req.onerror = function () { finish(false); };
    // Blocked means something still holds the database — never hang the boot waiting for it.
    req.onblocked = function () { finish(false); };
    setTimeout(function () { finish(false); }, 5000);
  });
}

// Returns true when it removed a poisoned datadir (the next create() then rebuilds from scratch).
// Silent and cheap on the happy path: one open+close, and nothing at all on a device that has
// never booted this project.
// Returns 'ok' (nothing to do), 'healed' (poisoned datadir removed — create() will rebuild), or
// 'blocked' (poisoned AND still held, so it cannot be repaired in this worker's lifetime).
//
// Deliberately does NOT consult indexedDB.databases() to decide whether to look. That gate was
// wrong twice over: WebKit's databases() has a history of omitting entries, and a miss there sent
// the boot straight into the NotFoundError this function exists to prevent — the failure mode is
// silence, which is the worst kind. Probing costs one open+close, and "broken" is defined tightly
// enough that a project which has never booted here can't be mistaken for it: IDBFS only ever
// opens at DB_VERSION 21, so a datadir at version >= 21 with no FILE_DATA store is the poisoned
// state, while open() on a name that doesn't exist yet yields an empty database at version 1.
async function __pgliteHealDatadir() {
  if (typeof indexedDB === 'undefined') return 'ok';
  var dbName = __pgliteIdbDbName();
  try {
    var probe = await __pgliteProbeDatadir(dbName);
    // The verdict carries WHAT IT SAW, not just what it decided. "ok" alone cannot distinguish a
    // healthy datadir from one that does not exist, and those two want different next steps.
    if (probe === null) return 'ok(uninspectable ' + dbName + ')';
    var seen = dbName + ' v' + probe.version + ' [' + probe.stores.join(',') + ']';
    if (probe.stores.indexOf('FILE_DATA') >= 0) return 'ok(healthy ' + seen + ')';
    if (probe.version < 21) return 'ok(fresh ' + seen + ')';
    swEvent({ step: 'transform', level: 'warn', message: 'pglite: local datadir is unopenable (v' + probe.version + ', no FILE_DATA store) — rebuilding it' });
    var deleted = await __pgliteDeleteDatadir(dbName);
    swEvent({
      step: 'transform',
      level: deleted ? 'success' : 'error',
      message: deleted
        ? 'pglite: local datadir rebuilt — the Local rows stored here were already unreadable'
        : 'pglite: the unopenable datadir is still held by this worker — a reload releases it',
    });
    return deleted ? 'healed' : 'blocked';
  } catch (e) {
    return 'ok';
  }
}

var __pgliteReady = null;
// The preview-identity wire — the SW-scope "view as" identity {userId, role}, set by the page via the
// trivial:set-identity message (see the listener below). Read by the dev handler dispatch (__devDispatch,
// dev-handler-runtime.ts) so the preview app's OWN fetch('/api/<route>') calls scope to it — those can't
// carry the x-trivial-as-* headers, so a store value alone isn't enough. null ⇒ owner/sees-all default
// (byte-identical to today). Lives in the pglite substrate (present whenever the flag is on, independent
// of handlers) so the single message listener owns it; harmlessly unused when handlers is off.
var __pgliteViewAs = null;

// the datadir can also die UNDER a handle that booted fine: IDBFS keeps the database open
// and syncs writes to it, so if the store goes away afterwards (eviction, an external delete, a
// jetsam mid-write) every subsequent query throws NotFoundError while __pgliteReady still holds a
// db that will never work again. Healing only on boot missed exactly that: the failure came back
// in 49ms on the device — far too fast to be a boot — because nothing ever discarded the handle.
function __pgliteDatadirGone(err) {
  var m = String((err && (err.name ? err.name + ': ' + err.message : err.message)) || err || '');
  return /NotFoundError/i.test(m)
    || /object can not be found here/i.test(m)      // WebKit's older wording
    || /object stores was not found/i.test(m);      // Blink's, and newer WebKit's
}

// Throw away the booted handle so the NEXT call re-boots — and re-runs the datadir probe, which
// is what actually repairs the database. Safe to call repeatedly.
function __pgliteDiscardDb() {
  var dead = __pgliteReady;
  __pgliteReady = null;
  if (!dead) return;
  try {
    dead.then(function (db) { try { db.close(); } catch (e) { /* noop */ } }, function () { /* already failed */ });
  } catch (e) { /* noop */ }
  swEvent({ step: 'transform', level: 'warn', message: 'pglite: the local datadir vanished under a live connection — discarding it and rebuilding on the next read' });
}

function __pgliteGetDb() {
  if (!__pgliteReady) {
    __pgliteReady = (async function () {
      swEvent({ step: 'transform', level: 'dim', message: 'pglite: booting build DB…' });
      var boot = (async function () {
        // check the datadir is openable BEFORE PGlite touches it. Must happen here, not
        // in a catch: once create() has failed, its own IDB handle blocks the delete.
        // Step markers. WebKit's DOMExceptions carry no stack, so on the one engine where this
        // breaks, "which step" is otherwise unknowable — the whole boot is a single opaque throw.
        var __t0 = Date.now();
        var mark = function (m) { swEvent({ step: 'transform', level: 'dim', message: 'pglite: ' + m + ' (+' + (Date.now() - __t0) + 'ms)' }); };
        var heal = await __pgliteHealDatadir();
        mark('datadir probe → ' + heal);
        if (heal === 'blocked') {
          // Poisoned AND held. Calling create() here would fail anyway AND open one more
          // connection on the database we're trying to delete — each retry making the repair
          // less possible. Stop, and say the one thing that does fix it: a reload discards this
          // worker, releases every handle, and the next boot's probe deletes the datadir cleanly.
          throw new Error('Local data on this device needs a reload to finish rebuilding');
        }
        // the three-asset boot — ALL three pre-compiled/blobbed BEFORE PGlite.create (the #1
        // footgun: a missing/mis-served asset hangs the boot). Ported verbatim from sw.ts.
        var assets = await Promise.all([
          WebAssembly.compile(await fetch('/api/iframe-runtime/pglite-0.5.3.wasm').then(function (r) { return r.arrayBuffer(); })),
          WebAssembly.compile(await fetch('/api/iframe-runtime/initdb-0.5.3.wasm').then(function (r) { return r.arrayBuffer(); })),
          fetch('/api/iframe-runtime/pglite-0.5.3.data').then(function (r) { return r.blob(); }),
        ]);
        // Sizes, not just "ready": a 6MB fsBundle that arrives as a handful of bytes is a
        // failure mode this boot has actually hit, and it presents as an unrelated throw inside
        // PGlite rather than as a fetch error.
        // Defensive on purpose: a diagnostic that can throw takes the boot down with it, and this
        // one runs on every boot on every device. (The test harness's minimal WebAssembly stub has
        // no .Module, and caught exactly that.)
        mark('3 assets ready — fsBundle ' + ((assets[2] && assets[2].size) || '?') + 'B, modules '
          + (typeof WebAssembly !== 'undefined' && WebAssembly.Module
              ? (assets[0] instanceof WebAssembly.Module) + '/' + (assets[1] instanceof WebAssembly.Module)
              : 'n/a'));
        var db = await PGlite.create(__pgliteIdbName(), { pgliteWasmModule: assets[0], initdbWasmModule: assets[1], fsBundle: assets[2] });
        mark('PGlite.create ok → ' + __pgliteIdbName());
        // boot the PER-PROJECT schema (the manifest's compiled dataSchema) when the maker
        // declared one, else EMPTY (no manifest ⇒ no tables/RLS — absence means empty; the maker's
        // data comes from their own declared schema + the Data app, never a canned demo). Idempotent
        // throughout: DDL is CREATE…IF NOT EXISTS, RLS is DROP…IF EXISTS + CREATE, GRANTS are
        // duplicate-guarded — so the same steps re-apply on a manifest change (__pgliteReapplySchema).
        var pgSchema = await __pgliteResolveSchema();
        mark('schema resolved');
        if (pgSchema.ddl) await db.exec(pgSchema.ddl);
        if (pgSchema.rls) await db.exec(pgSchema.rls);
        if (pgSchema.grants) await db.exec(pgSchema.grants);
        await db.exec('CREATE TABLE IF NOT EXISTS _boots (id serial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())');
        await db.exec('INSERT INTO _boots DEFAULT VALUES'); // one row per fresh boot -> boots>1 proves IDB persistence
        return db;
      })();
      // The CEILING, not the caller's patience: only a boot this long is abandoned. Racing the
      // caller's 15s here (as this used to) was the bug — see below.
      var ceiling = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('pglite boot exceeded ' + PGLITE_BOOT_CEILING_MS + 'ms')); }, PGLITE_BOOT_CEILING_MS); });
      var ready = await Promise.race([boot, ceiling]);
      swEvent({ step: 'transform', level: 'success', message: 'pglite: build DB ready' });
      return ready;
    })().catch(function (err) {
      __pgliteReady = null; // a genuine failure ⇒ the next request may start a fresh attempt
      // Name AND stack: WebKit's message alone ("The object can not be found here.") names neither
      // the API that threw nor the resource it wanted, so a bare message sends you hunting.
      swEvent({
        step: 'transform',
        level: 'error',
        message: 'pglite boot failed: ' + ((err && (err.name ? err.name + ': ' + err.message : err.message)) || err)
          + ' @ ' + String((err && err.stack) || '').split('\\n').slice(0, 4).join(' | '),
      });
      throw err;
    });
  }

  // the caller's deadline is SEPARATE from the boot, and expiring it must not touch
  // __pgliteReady. It used to: the 15s race rejected AND nulled the handle while PGlite.create was
  // still running, so the Data app's 1.5s retry started a SECOND PGlite over the SAME IDBFS
  // datadir. Two mounts racing one database is both a memory multiplier and a very good way to
  // leave that database at v21 with no FILE_DATA store — i.e. the timeout manufactured the
  // permanent corruption above. Now a slow boot is joined, never duplicated: this caller gives up,
  // the boot continues, and the next caller waits on the same promise.
  var shared = __pgliteReady;
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      // Deliberately a WAITING message, not a diagnosis: the boot is still running, and the old
      // text ("check the 3 wasm assets are served at…") blamed our asset serving in the maker's
      // face for what is almost never an asset problem. isLocalTransportNotReady matches this.
      reject(new Error('Local data is still starting up'));
    }, PGLITE_BOOT_TIMEOUT_MS);
    shared.then(
      function (db) { clearTimeout(timer); resolve(db); },
      function (err) { clearTimeout(timer); reject(err); }
    );
  });
}

// the build-side connection-discipline wrapper (the sole raw-handle holder; mirror of the run side).
// Dual-axis (the preview-identity wire): stamps BOTH identity GUCs — app.user_id + app.user_role — the
// exact pair __devAsUser (dev-handler-runtime.ts) stamps, so the Data-app read path and the handler
// path scope identically and can never drift. role null ⇒ '' (no role), same convention as userId.
async function __pgliteAsUser(db, userId, role, fn) {
  return db.transaction(async function (tx) {
    await tx.exec('SET LOCAL ROLE app_user');
    await tx.query("SELECT set_config('app.user_id', $1, true)", [userId == null ? '' : String(userId)]);
    await tx.query("SELECT set_config('app.user_role', $1, true)", [role == null ? '' : String(role)]);
    return fn(tx);
  });
}

// resolve the schema the build DB boots: the per-project manifest's compiled dataSchema (ddl/
// rls/grants, shipped in /iframe/manifest.json) when present, else EMPTY (no declared manifest ⇒ no
// tables — only the bare app_user role, see PGLITE_EMPTY_GRANTS). getManifest is the shared SW manifest
// cache (fetch-once, invalidated on source change) — so this rides the SAME fetch/cache the resolver
// uses; a fetch failure ALSO lands empty (DEFAULT_MANIFEST has no dataSchema) — honest degradation, and
// a later __pgliteReapplySchema/boot re-resolves the declared schema.
async function __pgliteResolveSchema() {
  try {
    var m = await getManifest();
    if (m && m.dataSchema && m.dataSchema.ddl) {
      return { ddl: m.dataSchema.ddl, rls: m.dataSchema.rls || '', grants: m.dataSchema.grants || '' };
    }
  } catch (e) { /* fall through to the empty default */ }
  return { ddl: '', rls: '', grants: PGLITE_EMPTY_GRANTS };
}

// re-apply the per-project schema to an ALREADY-BOOTED build DB when the manifest changes (the
// maker edits src/trivial.manifest.json). Additive + idempotent (CREATE…IF NOT EXISTS / DROP…IF EXISTS
// +CREATE / guarded GRANTs), matching the run-seam migrate: new tables + policy changes apply, existing
// rows are untouched (a column ADD on an existing table is a Phase-2 follow-up, as on the run side). A
// no-op if the DB hasn't booted yet — the next boot resolves the fresh schema. The caller invalidated
// getManifest first, so this reads the NEW dataSchema.
async function __pgliteReapplySchema() {
  if (!__pgliteReady) return;
  try {
    var db = await __pgliteReady;
    var s = await __pgliteResolveSchema();
    if (s.ddl) await db.exec(s.ddl);
    if (s.rls) await db.exec(s.rls);
    if (s.grants) await db.exec(s.grants);
    swEvent({ step: 'transform', level: 'success', message: 'pglite: data schema re-applied' });
  } catch (err) {
    swEvent({ step: 'transform', level: 'error', message: 'pglite schema re-apply failed: ' + (err && err.message || err) });
  }
}

function __pgliteStripMaker(q) {
  // / parity — strip the canonical maker-plane last disjunct before labeling
  // (lockstep with index.ts stripMakerDisjunct).
  if (q.indexOf("'trivial:maker'") < 0) return q;
  // NB this sits in a PLAIN template literal — backslashes must be DOUBLED or the emitted SW
  // regex loses them and the whole SW dies with an invalid-group SyntaxError (the 2026-08-08
  // C001: every canvas preview empty-rooted for ~35 min).
  var s = q.replace(/\\s*or\\s+\\(?current_setting\\('app\\.user_role'(?:::text)?,\\s*true\\)\\s*=\\s*'trivial:maker'(?:::text)?\\)?/gi, '').trim();
  for (;;) {
    if (!(s.charAt(0) === '(' && s.charAt(s.length - 1) === ')')) break;
    var depth = 0; var whole = true;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0 && i < s.length - 1) { whole = false; break; } }
    }
    if (!whole) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}
function __pgliteAccessFromQual(cmd, qual) {
  // that phase parity: derive the label from the per-command select policy (USING); the old FOR ALL pair
  // is gone, and insert/update/delete are command-scoped (cmd !== SELECT) so ignored here. that phase:
  // mirror index.ts -- managed (role+id), and the post-NULLIF forms (IS NOT NULL = authenticated).
  if (cmd !== 'SELECT') return null;
  var q = __pgliteStripMaker(String(qual || '').toLowerCase().trim());
  if (q === 'true' || q === '(true)') return 'public';
  var hasRole = q.indexOf('app.user_role') >= 0;
  var hasId = q.indexOf('app.user_id') >= 0;
  if (hasRole && hasId) return 'managed';
  if (hasRole) return 'role';
  if (q.indexOf('is not null') >= 0) return 'authenticated';
  if (hasId) return 'owner';
  return q ? 'custom' : null;
}
async function __pgliteTableAccess(db, table) {
  var rows = (await db.query("SELECT cmd, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = $1", [table])).rows;
  for (var i = 0; i < rows.length; i++) {
    var a = __pgliteAccessFromQual(rows[i].cmd, rows[i].qual);
    if (a) return a;
  }
  return 'unrestricted';
}
function __pgliteSafeIdent(name) { return /^[a-z_][a-z0-9_]{0,62}$/i.test(String(name || '')); }

// --- the Data-app reads (admin/superuser → sees all; the same JSON shape as the real API) ---
async function __pgliteListTables(db) {
  var rows = (await db.query("SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\\\_%' ORDER BY c.relname")).rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) out.push({ table: rows[i].table, access: await __pgliteTableAccess(db, rows[i].table) });
  return { tables: out };
}
async function __pgliteGetSchema(db, table) {
  if (!__pgliteSafeIdent(table)) return null;
  var cols = (await db.query("SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS \\"default\\", COALESCE(bool_or(p.contype = 'p'), false) AS pk FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum LEFT JOIN pg_constraint p ON p.conrelid = a.attrelid AND p.contype = 'p' AND a.attnum = ANY(p.conkey) WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped GROUP BY a.attname, a.atttypid, a.atttypmod, a.attnotnull, d.adbin, d.adrelid, a.attnum ORDER BY a.attnum", [table])).rows;
  if (!cols.length) return null;
  var columns = cols.map(function (c) { return { name: c.name, type: c.type, nullable: c.nullable, default: c.default, pk: c.pk }; });
  var access = await __pgliteTableAccess(db, table);
  var ddlCols = columns.map(function (c) { return '  ' + c.name + ' ' + c.type + (c.nullable ? '' : ' NOT NULL') + (c.default ? ' DEFAULT ' + c.default : '') + (c.pk ? ' PRIMARY KEY' : ''); }).join(',\\n');
  var ddl = '-- access: ' + access + ' (Trivial-generated RLS)\\nCREATE TABLE ' + table + ' (\\n' + ddlCols + '\\n);';
  return { columns: columns, access: access, ddl: ddl };
}
async function __pgliteGetRows(db, table, limit, cursor, userId, role) {
  if (!__pgliteSafeIdent(table)) return null;
  var reg = (await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['public."' + table + '"'])).rows[0];
  if (!reg || !reg.ok) return null;
  var lim = Math.min(Math.max(1, Number(limit) || 50), 200);
  var run = async function (tx) {
    var res;
    if (cursor != null) res = await tx.query('SELECT * FROM public."' + table + '" WHERE id > $1 ORDER BY id ASC LIMIT $2', [cursor, lim + 1]);
    else res = await tx.query('SELECT * FROM public."' + table + '" ORDER BY id ASC LIMIT $1', [lim + 1]);
    return res;
  };
  // userId present -> RLS-scoped (mock end-user, the isolation proof; dual-axis — role widens
  // managed/role tables); else admin (sees all, the owner/today default).
  var res = userId != null ? await __pgliteAsUser(db, userId, role, run) : await run(db);
  var rows = res.rows.slice(0, lim);
  var last = rows[rows.length - 1];
  var nextCursor = (res.rows.length > lim && last && typeof last.id === 'number') ? last.id : null;
  return { rows: rows, nextCursor: nextCursor };
}
// --- P3 write-back (build mode only). Admin/superuser conn — the owner edits any row in their dev
// DB (matches the admin browse). Idents are __pgliteSafeIdent-gated; values are parameterized. ---
async function __pgliteUpdateCell(db, table, pkCol, pkVal, col, val) {
  if (!__pgliteSafeIdent(table) || !__pgliteSafeIdent(pkCol) || !__pgliteSafeIdent(col)) return null;
  await db.query('UPDATE public."' + table + '" SET "' + col + '" = $1 WHERE "' + pkCol + '" = $2', [val, pkVal]);
  return { ok: true };
}
async function __pgliteInsertRow(db, table, values) {
  if (!__pgliteSafeIdent(table)) return null;
  var cols = Object.keys(values || {}).filter(__pgliteSafeIdent);
  if (!cols.length) { await db.query('INSERT INTO public."' + table + '" DEFAULT VALUES'); return { ok: true }; }
  var ph = [], vals = [];
  for (var i = 0; i < cols.length; i++) { ph.push('$' + (i + 1)); vals.push(values[cols[i]]); }
  await db.query('INSERT INTO public."' + table + '" ("' + cols.join('", "') + '") VALUES (' + ph.join(', ') + ')', vals);
  return { ok: true };
}
async function __pgliteDeleteRow(db, table, pkCol, pkVal) {
  if (!__pgliteSafeIdent(table) || !__pgliteSafeIdent(pkCol)) return null;
  await db.query('DELETE FROM public."' + table + '" WHERE "' + pkCol + '" = $1', [pkVal]);
  return { ok: true };
}
// --- P4 export — dump every table's rows (admin/superuser conn → all rows) for the publish-time
// run-Postgres seed. Same admin view as the catalog reads; the seeder carries the owner values. ---
async function __pgliteExport(db) {
  // .tables, not the object. __pgliteListTables returns { tables: [...] }, and this read it as an
  // array — so tables.length was undefined, the loop ran zero times, and export ALWAYS returned
  // { tables: [] } no matter how many rows existed. Publish seeds the live database from exactly
  // this call, so every publish shipped an empty database while the maker's Draft rows sat there
  // intact. Silent by shape: an empty export is indistinguishable from a project with no data.
  // Found on a real iPad, where listTables reported 'notes' and getRows returned two rows in the
  // same round-trip that export answered empty.
  var tables = (await __pgliteListTables(db)).tables;
  var out = [];
  for (var i = 0; i < tables.length; i++) {
    var t = tables[i].table;
    if (!__pgliteSafeIdent(t)) continue;
    var rows = (await db.query('SELECT * FROM public."' + t + '" ORDER BY id ASC')).rows;
    out.push({ table: t, rows: rows });
  }
  return { tables: out };
}


// --- the one dispatch every host calls -------------------------------------------
// Both hosts — the Service Worker bridge today, the dedicated Worker from Phase 1 — route their
// messages through THIS function. The verbs are the product's contract with the Data panel, and a
// host that re-implements the switch is a host that drifts from the other one silently. Same
// reason dev-handler-runtime.ts exists: build and run must not fork.
//
// Returns { ok: true, result } or { ok: false, error }. It never throws, so a bridge cannot forget
// to catch; a DEAD-DATADIR failure is reported as such so each host can discard its handle and let
// its own retry drive the rebuild.
async function __pgliteDispatch(method, args) {
  var a = args || {};
  try {
    var db = await __pgliteGetDb();
    var result;
    if (method === 'listTables') result = await __pgliteListTables(db);
    else if (method === 'getSchema') result = await __pgliteGetSchema(db, a.table);
    else if (method === 'getRows') result = await __pgliteGetRows(db, a.table, a.limit, a.cursor, a.userId, a.role);
    else if (method === 'updateCell') result = await __pgliteUpdateCell(db, a.table, a.pkCol, a.pkVal, a.col, a.val);
    else if (method === 'insertRow') result = await __pgliteInsertRow(db, a.table, a.values);
    else if (method === 'deleteRow') result = await __pgliteDeleteRow(db, a.table, a.pkCol, a.pkVal);
    else if (method === 'export') result = await __pgliteExport(db);
    else if (method === 'ping') {
      var ver = (await db.query('SHOW server_version')).rows[0].server_version;
      var boots = (await db.query('SELECT count(*)::int AS n FROM _boots')).rows[0].n;
      result = { pgVersion: ver, boots: boots };
    } else return { ok: false, error: 'unknown method: ' + method };
    return { ok: true, result: result };
  } catch (err) {
    swEvent({
      step: 'transform',
      level: 'error',
      message: 'pglite data.' + method + ' failed: ' + ((err && (err.name ? err.name + ': ' + err.message : err.message)) || String(err)),
    });
    if (__pgliteDatadirGone(err)) {
      __pgliteDiscardDb();
      return { ok: false, error: 'Local data is rebuilding', datadirGone: true };
    }
    return { ok: false, error: String((err && err.message) || err) };
  }
}
`;
