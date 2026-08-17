/**
 * pglite-substrate — the build-side PGLite substrate spliced into the canvas preview
 * Service Worker (sw-source.ts), gated on DYNAMIC_APPS_ENABLED.
 *
 * PGLite runs in the SW (IndexedDB-persisted), loading the SAME RLS the run-Postgres uses (the
 * manifest-compiled dataSchema shipped in /iframe/manifest.json — the byte-identical generateAll()
 * output → build↔run parity), behind the same connection discipline (asUser: SET LOCAL ROLE app_user
 * + the app.user_id GUC — the default PGLite connection is superuser and bypasses RLS, so this is
 * the sole tenant-query path). The platform Data app reads build data cross-origin via a postMessage
 * bridge (P2) → the SW's `trivial:data` listener (registered here) → JSON byte-shaped like the real
 * dynamic-data API.
 *
 * NEVER reaches a published-site visitor: it lives only in the platform preview SW, spliced empty
 * when the flag is off (the SW stays byte-identical to today).
 *
 * ABSENCE MEANS EMPTY: a project WITHOUT `src/trivial.manifest.json` boots an EMPTY substrate — no
 * tables, no RLS, no mock rows (the Data app shows "No tables." and its declare surface is the entry
 * point). The retired  fallback booted the fixed 4-table demo + alice/bob/dm mock rows for every
 * manifest-less project — right while the tier was dark, wrong once live. NB a preview that booted
 * under the old fallback may still SHOW the demo tables client-side: PGLite persists in IndexedDB
 * and this substrate never drops tables (a declared schema applies additively), so a stale demo set
 * lingers until the preview DB is reset. The catalog reads (listTables/getSchema/getRows) are the
 * Data-app ADMIN view (superuser → sees all rows, like the real owner-admin read); asUser is the
 * runtime discipline.
 */

import { PGLITE_CORE_SOURCE } from './pglite-core.js';
export { PGLITE_CORE_SOURCE };

/**
 * The identity wire, kept when the data plane leaves.
 *
 * The canvas identity picker posts `trivial:set-identity` to THIS worker, and the relay forwards
 * the value with every request because the data worker is a different thread and never receives
 * that message. So the Service Worker still holds the value — it just no longer holds a database
 * to apply it to.
 */
export const PGLITE_IDENTITY_WIRE_SOURCE = String.raw`
// === preview identity + data plane wire (relay-only) =========================================
var __pgliteViewAs = null;

// Which data this frame reads: its maker's Draft (the default) or the project's Live data.
//
// The shell states it on every boot, because the SERVER is the only party that knows the seat —
// an owner or editor gets 'draft', a viewer or a stranger on a link gets 'live'. It is restated
// each boot rather than latched, so a browser that viewed someone's project and is later invited
// as an editor goes back to Draft without anyone clearing anything.
//
// Default 'draft' preserves today's behaviour for any host that never posts.
var __dataPlane = 'draft';

self.addEventListener('message', function (event) {
  var d = event.data;
  if (d && d.type === 'trivial:set-data-plane') { __dataPlane = d.plane === 'live' ? 'live' : 'draft'; return; }
  if (!d || d.type !== 'trivial:set-identity') return;
  // '' (anon) is meaningful and distinct from null (owner/unset): both GUC axes preserved verbatim.
  __pgliteViewAs = {
    userId: d.userId == null ? null : String(d.userId),
    role: d.role == null ? null : String(d.role),
  };
});
// === end preview identity wire ===============================================================
`;

/** The top-of-module ESM import (spliced at the `// __PGLITE_IMPORT__` marker). */
export const PGLITE_IMPORT_SOURCE = "import { PGlite } from '/api/iframe-runtime/pglite-0.5.3.js';";

/**
 * The substrate body (spliced at the `// __PGLITE_SUBSTRATE__` marker). `swEvent` is in scope (the
 * same SW module). The SQL is inlined as JSON-stringified string literals; the rest uses plain
 * concatenation to avoid nested-template-literal escaping. Boot is lazy (first data message),
 * diagnostic-wrapped, and timed out — the three-asset footgun mitigation.
 */
export const PGLITE_SW_BRIDGE_SOURCE = `// --- the SW-side data dispatch (its OWN message listener; the existing handler is untouched) ---
// P2 wires the platform Data app -> the preview iframe -> postMessage here -> result back.
self.addEventListener('message', function (event) {
  var d = event.data;
  if (!d) return;
  // re-apply the per-project data schema when the manifest changes: an explicit
  // 'trivial:invalidate-manifest' (posted by the Data-app write in Phase 2) OR a 'trivial:source-changed'
  // that carried src/trivial.manifest.json. Invalidate the shared manifest cache first (so the re-resolve
  // re-fetches the new dataSchema), then re-apply idempotently to the booted DB. Its own listener — the
  // shared handleSourceChanged (which also HMRs on source-changed) is untouched.
  if (d.type === 'trivial:invalidate-manifest'
      || (d.type === 'trivial:source-changed' && Array.isArray(d.paths)
          && d.paths.some(function (p) { return (p && (p.path || p)) === 'src/trivial.manifest.json'; }))) {
    invalidateManifest();
    var reapply = __pgliteReapplySchema();
    //  Phase 2 — when the Data-app poster tagged a requestId (the shell's data.invalidateManifest
    // relay), ack back to the source once the re-apply settles so the canvas reload sees the new schema
    // race-free. The WS source-changed path carries no requestId → no ack (byte-identical to Phase 1).
    if (d.requestId && event.source) {
      var __src = event.source;
      reapply.then(function () { try { __src.postMessage({ type: 'trivial:manifest-reapplied', requestId: d.requestId }); } catch (e) { /* noop */ } });
    }
    if (event.waitUntil) event.waitUntil(reapply); else void reapply;
    return;
  }
  // The preview-identity wire — stash the page-posted "view as" identity in the SW scope. Read by the
  // dev handler dispatch (__devDispatch, dev-handler-runtime.ts) so the preview app's OWN
  // fetch('/api/<route>') calls scope to it; the Data app's bridge reads instead carry identity
  // per-request (data.getRows args). Fire-and-forget — the shell already acked ok synchronously.
  // '' (anon) is meaningful and distinct from null (owner/unset): both GUC axes preserved verbatim.
  if (d.type === 'trivial:set-identity') {
    __pgliteViewAs = {
      userId: d.userId == null ? null : String(d.userId),
      role: d.role == null ? null : String(d.role),
    };
    return;
  }
  if (d.type !== 'trivial:data') return;
  var reply = function (payload) { try { if (event.source) event.source.postMessage(Object.assign({ type: 'trivial:data-result', requestId: d.requestId }, payload)); } catch (e) { /* noop */ } };
  var work = __pgliteDispatch(d.method, d.args).then(function (res) {
    // The dispatch lives in the core so both hosts share one implementation; this
    // bridge's whole job is now getting a message in and a reply out. Errors are already shaped
    // and already logged by the time they arrive here.
    reply(res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error });
  });

  // tell the browser this event is still in flight. A PGlite boot takes seconds, and
  // without this the message event is "done" the moment the IIFE yields, leaving the worker
  // collectable mid-boot; the sibling 'trivial:invalidate-manifest' branch above already does it.
  // WebKit is the engine that actually enforces the difference.
  if (event.waitUntil) event.waitUntil(work);
});
swEvent({ step: 'install', level: 'dim', message: 'pglite substrate registered' });
// === end PGLite build-data substrate ========================================================
`;

/**
 * The full substrate as the Service Worker splices it: the host-agnostic core plus the SW
 * bridge. Concatenation order is the contract — `getServiceWorkerSource()` emits exactly what it
 * emitted before this file was split.
 */
export const PGLITE_SUBSTRATE_SOURCE = PGLITE_CORE_SOURCE + PGLITE_SW_BRIDGE_SOURCE;

/**
 * The /api/data dispatch — the SW answers the BUILD frame's own SDK
 * fetches (`db.from(...)` → `fetch('/api/data/<pid>/<table>[/<id>]')`) from the in-SW PGLite,
 * speaking the run gateway's exact wire (controllers/dynamic-data.ts endUser* + mapDataError).
 * A thin HTTP adapter over the SAME ctx verbs the handler tier uses (__devMakeCtx, spliced from
 * DEV_DATA_CORE_SOURCE whenever pglite is on) — owner-strip, SET LOCAL ROLE app_user + the dual
 * identity GUCs, field projection — so build and run can never drift on verb semantics.
 * Spliced with the substrate under DYNAMIC_APPS_ENABLED; NOT gated on the handler flag.
 * ES5-in-a-string discipline: String.raw, no backticks, no ${, placeholders by concatenation.
 */
/**
 * The URL test, alone.
 *
 * Split out because the Service Worker still has to decide which fetches are ours — that is the one
 * job it keeps — while everything behind the decision moved to the host. It is a pure string test
 * with no database, no manifest and no identity behind it, which is why it can live on the side
 * that has none of them, and why asking the other thread would be absurd: a postMessage round trip
 * on every fetch the preview makes, to answer a question about a pathname.
 */
export const DATA_CANDIDATE_SOURCE = String.raw`
// === /api/data URL test (shared by the dispatch and the relay) ================================
function __dataIsCandidate(url) {
  return url.origin === self.location.origin && url.pathname.indexOf('/api/data/') === 0;
}
// === end /api/data URL test ==================================================================
`;

export const DATA_API_DISPATCH_SOURCE = String.raw`
// === /api/data dispatch — the build frame's SDK served from PGLite (run-wire parity) =========
function __dataJson(status, body) {
  return new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
// The dev mirror of dynamic-data.ts mapDataError — same statuses, same bodies, never leaks SQL
// detail. PGLite is real Postgres, so the same error .code map applies (42501 = RLS/role wall).
function __dataMapError(e) {
  var msg = String((e && e.message) || e);
  if (msg === 'no updatable fields') return __dataJson(400, { error: 'no updatable fields' });
  if (msg.indexOf('forbidden: cannot write withheld field') === 0) return __dataJson(403, { error: msg });
  // The run wire's missing-table body comes from the introspection layer ('table not found'),
  // NOT mapDataError's 'Not found' (which is the row-miss shape) — pinned by validate-wire-parity.
  if (msg.indexOf('table not found:') === 0) return __dataJson(404, { error: 'table not found' });
  if (msg.indexOf('value too large:') === 0) return __dataJson(400, { error: msg }); //  P0b (run parity: badRequest 400)
  if (msg.indexOf('unknown fields:') === 0) return __dataJson(400, { error: msg }); //  (run parity: all-unknown insert is a loud 400, never an all-null 201)
  if (msg.indexOf('invalid table:') === 0) return __dataJson(400, { error: 'Invalid table' });
  var code = e && e.code;
  if (code === '42501') return __dataJson(403, { error: 'Forbidden by data policy' });
  if (code === '57014') return __dataJson(503, { error: 'Query cancelled (statement timeout)' });
  if (code === '23502' || code === '23514' || code === '23505' || code === '22P02' || code === '22003') return __dataJson(400, { error: 'Invalid data' });
  if (code === '42P01' || code === '3F000' || code === '3D000' || code === '42704') return __dataJson(404, { error: 'Not found' });
  return __dataJson(500, { error: 'Data API error' });
}
//  — the remedial-preview wire. When the app's OWN data calls hit the signed-out wall
// (this plane has no sees-all: owner-default scopes as anonymous), the frame chrome should teach
// the remedy ("pick a Local user"), not leave the app looking silently broken. The SW is the ONE
// place that knows both the identity and the refusal, so it emits a debounced note to its window
// clients; the shell forwards it to the workshop, which renders the remedy pill on the frame —
// never injected into the app's own UI. Debounce: once per table+reason per 30s window, reset
// whenever the identity changes (a fresh identity deserves fresh signals).
var __remedySeen = Object.create(null);
var __remedyIdentityKey = '';
function __emitPreviewRemedy(identity, table, reason) {
  try {
    var anon = identity == null || identity.userId == null || identity.userId === '';
    if (!anon) return;
    var ik = String((identity && identity.userId === '') ? 'anon' : 'owner');
    if (ik !== __remedyIdentityKey) { __remedyIdentityKey = ik; __remedySeen = Object.create(null); }
    var key = table + '|' + reason;
    var now = Date.now();
    if (__remedySeen[key] && now - __remedySeen[key] < 30000) return;
    __remedySeen[key] = now;
    self.clients.matchAll({ type: 'window' }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) {
        cs[i].postMessage({ type: 'trivial:preview-remedy', table: table, reason: reason });
      }
    }).catch(function () {});
  } catch (e) { /* never let the teaching wire break the data path */ }
}
// viewAs: the preview identity for THIS request. Passed explicitly by the data host, where one
// worker serves several tabs that may each be previewing as a different person; omitted in the
// Service Worker, where the frame's own global is the only identity there is.
async function __dataDispatch(request, url, viewAs) {
  try {
    var parts = url.pathname.split('/'); // ['', 'api', 'data', pid, table, id?]
    var projectId = parts[3] ? decodeURIComponent(parts[3]) : '';
    var table = parts[4] ? decodeURIComponent(parts[4]) : '';
    var id = (parts.length > 5 && parts[5] !== '') ? decodeURIComponent(parts[5]) : null;
    if (!projectId) return __dataJson(400, { error: 'Invalid project' });
    // Cross-project wall: this SW holds ONLY its own project's build DB. Any other projectId is,
    // from this substrate's view, an unprovisioned project — the run gateway's 404 shape
    // (mapDataError 3F000/42P01), never another project's data. The manifest (the same shared
    // fetch/cache the schema boot rides) carries the frame's own projectId.
    var man = null;
    try { man = await getManifest(); } catch (e2) { man = null; }
    var own = man && man.projectId;
    // 'table not found' — the run wire's body for a request against an unprovisioned project
    // (its per-table introspection misses), pinned by validate-wire-parity.
    if (!own || String(own) !== projectId) return __dataJson(404, { error: 'table not found' });
    if (!__devSafeIdent(table)) return __dataJson(400, { error: 'Invalid table' });
    // Identity: header override > the view-as wire > anonymous — the SAME priority as the handler
    // dispatch. userId null scopes as '' inside __devAsUser (anonymous/public-only, the run side's
    // NULLIF('') semantics) — the app NEVER has a sees-all mode, exactly like the published site;
    // view-as Owner therefore previews as an anonymous visitor. The Data app's admin view is a
    // separate plane (the trivial:data message ops), untouched.
    var vw = viewAs || ((typeof __pgliteViewAs !== 'undefined' && __pgliteViewAs) ? __pgliteViewAs : { userId: null, role: null });
    var hu = request.headers.get('x-trivial-as-user');
    var hr = request.headers.get('x-trivial-as-role');
    var identity = { userId: (hu != null && hu !== '') ? hu : vw.userId, role: (hr != null && hr !== '') ? hr : vw.role };
    var db = await __pgliteGetDb();
    var ctx = __devMakeCtx(db, identity);
    var method = request.method.toUpperCase();
    if (method === 'GET' && id == null) {
      var limit = Number(url.searchParams.get('limit')) || 50;
      var rawCur = url.searchParams.get('cursor');
      var curN = rawCur == null ? NaN : Number(rawCur);
      var cursor = isFinite(curN) ? curN : null;
      var page = await ctx.list(table, { limit: limit, cursor: cursor });
      // The preview remedy: an EMPTY read on an IDENTITY-SCOPED table under an anonymous identity is empty BY
      // CONSTRUCTION (RLS hides every row) — the app just looks broken. Teach the remedy. Keyed on
      // the SELECT policy's access (owner/authenticated/role/managed), NOT owner-column presence:
      // a public table can carry an ownerColumn (guestbook: public read + owner-stamped rows) and
      // must NOT nag, while an authenticated table with no ownerColumn still hides rows from anon
      // and SHOULD teach -- the exact false-pos/neg the column signal got backwards.
      if (!page.rows || page.rows.length === 0) {
        try {
          var acc = await __pgliteTableAccess(db, table);
          if (acc === 'owner' || acc === 'authenticated' || acc === 'role' || acc === 'managed') {
            __emitPreviewRemedy(identity, table, 'empty-owner-read');
          }
        } catch (e6) { /* unknown table etc. — the normal error paths own it */ }
      }
      return __dataJson(200, page);
    }
    if (method === 'POST' && id == null) {
      var body = null;
      try { body = await request.json(); } catch (e3) { body = null; }
      var values = (body && typeof body === 'object' && !(body instanceof Array)) ? body : {};
      // Mirror endUserInsert exactly: 201 with the (projected) row — even a null row body.
      return __dataJson(201, await ctx.insert(table, values));
    }
    if (method === 'PATCH') {
      // No PATCH route exists WITHOUT an id on the run side (express matches /:table/:id only) —
      // the wire answer for a missing id is the unrouted 404, not the controller's defensive 400.
      if (id == null || id === '') return __dataJson(404, { error: 'Not found' });
      var ubody = null;
      try { ubody = await request.json(); } catch (e4) { ubody = null; }
      var uvalues = (ubody && typeof ubody === 'object' && !(ubody instanceof Array)) ? ubody : {};
      var urow = await ctx.update(table, id, uvalues);
      return urow ? __dataJson(200, urow) : __dataJson(404, { error: 'Not found' });
    }
    if (method === 'DELETE') {
      if (id == null || id === '') return __dataJson(404, { error: 'Not found' }); // unrouted on run — see PATCH
      var ok = await ctx.remove(table, id);
      return ok ? new Response(null, { status: 204 }) : __dataJson(404, { error: 'Not found' });
    }
    // No such route on the run side either (e.g. GET/POST with an id, PUT) — the gateway 404s.
    return __dataJson(404, { error: 'Not found' });
  } catch (e5) {
    // The preview remedy: a policy-refused WRITE under an anonymous identity — the unambiguous "you acted while
    // signed out" moment. (42501 = the RLS wall; identity is function-scoped var, assigned before
    // any ctx op can throw it.)
    try {
      if (e5 && (e5.code === '42501' || String(e5.message || '').indexOf('forbidden') === 0)) {
        __emitPreviewRemedy(identity, table, 'refused-write');
      }
    } catch (e7) { /* never block the error mapping */ }
    return __dataMapError(e5);
  }
}
// === end /api/data dispatch ==================================================================
`;

/** The fetch-listener branch — mirrors DEV_HANDLER_FETCH_BRANCH_SOURCE; spliced under pglite,
 *  ORDERED BEFORE the handler branch (the handler dispatch already reserves the 'data' segment). */
export const DATA_FETCH_BRANCH_SOURCE =
  "if (typeof __dataIsCandidate === 'function' && __dataIsCandidate(url)) { event.respondWith(__dataDispatch(event.request, url)); return; }";

/**
 * The same branch, for the data-host transport.
 *
 * The Service Worker still INTERCEPTS the preview app's `fetch('/api/data/…')` — nothing else can,
 * which is why it keeps a job at all — but on WebKit it cannot answer, because it cannot hold a
 * PGlite. So it relays to the data-host client and reconstructs the Response from the reply.
 *
 * `__dataIsCandidate` stays local: it is a pure URL test with no database behind it, and asking
 * another thread whether a URL looks like ours would add a round trip to every single fetch the
 * preview makes.
 */
export const DATA_FETCH_BRANCH_HOST_SOURCE =
  "if (typeof __dataIsCandidate === 'function' && __dataIsCandidate(url)) { event.respondWith(__dataViaHost(event.request, url, null, event.clientId)); return; }";

/** The relay itself, spliced alongside the branch above. */
export const DATA_HOST_RELAY_SOURCE = `
// === /api/data relay to the data host =============================================
async function __dataViaHost(request, url, bundle, clientId) {
  // A seat with no Local data of its own reads LIVE, by going to the network — the same
  // /api/data/:projectId/:table route the published app calls, answered from run-PG under the same
  // RLS a stranger gets. The shell states the plane on every boot (it is the only party that knows
  // the seat), so this is a decision, not a timeout.
  //
  // That distinction is the whole point. "No host" is ambiguous: a viewer will never have one, and
  // a maker's is a second away from mounting. Falling through on ambiguity would make a maker's
  // preview silently read and WRITE production data, which is far worse than the wait it replaced.
  if (typeof __dataPlane !== 'undefined' && __dataPlane === 'live') return fetch(request);

  var body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try { body = await request.text(); } catch (e) { body = null; }
  }
  var headers = {};
  request.headers.forEach(function (v, k) { headers[k] = v; });

  // Relay through the frame that ASKED, which then hands the request up to the workshop.
  //
  // Clients.matchAll() is SAME-ORIGIN ONLY, so this worker cannot reach the data host directly:
  // the worker is registered from the shell on one origin, and the host frame is mounted by the
  // workshop on another. There is one path here rather than a same-origin fast path beside a
  // cross-origin fallback, because in local dev all three collapse to one host — a route only
  // production takes is a route only production exercises.
  //
  // The requesting client IS reachable: it is this worker's own controlled frame, same origin by
  // definition, and it has a parent that spans the gap. So the chain is:
  //
  //   SW -> shell frame (preview) -> workshop (trivial.so) -> data host (api) -> worker -> PGlite
  //
  // clientId comes from the FetchEvent, so the reply goes back to the frame that asked rather than
  // to an arbitrary one. That matters on the review surface, which mounts two shells at once
  // (ChangesSurface renders a main pane and a proposal pane side by side) under one SW scope.
  var client = null;
  try { if (clientId) client = await self.clients.get(clientId); } catch (e) { client = null; }
  if (!client) {
    // No clientId (or the frame died mid-request). Fall back to any controlled window: they all
    // share one workshop parent and one host, so any of them can carry the request.
    try {
      var windows = await self.clients.matchAll({ type: 'window' });
      client = windows.length ? windows[0] : null;
    } catch (e) { client = null; }
  }
  if (!client) {
    swEvent({ step: 'transform', level: 'warn', message: 'Local data: no frame to relay through for ' + url.pathname });
    return new Response(JSON.stringify({ error: 'Local data is still starting up' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }

  var reply = await new Promise(function (resolve) {
    var mc = new MessageChannel();
    // Closed on every exit path below. One channel is created per request, and a port left open is
    // a handle the runtime keeps alive — on a page doing steady polling that accumulates.
    var timer = null;
    var settle = function (v) {
      if (timer) { clearTimeout(timer); timer = null; }
      try { mc.port1.close(); } catch (e) {}
      resolve(v);
    };
    mc.port1.onmessage = function (e) { settle(e.data); };
    try {
      client.postMessage({ type: 'trivial:data-relay', req: {
        url: request.url, method: request.method, headers: headers, body: body,
        // The preview identity ("view as"). The shell posts it to THIS worker, and the handler
        // dispatch scopes rows by it — but the data worker is a different thread and never
        // receives that message, so it rides along per request. Per-request is also stricter than
        // a global: a stale one cannot leak one identity's rows into another request.
        viewAs: (typeof __pgliteViewAs !== 'undefined' && __pgliteViewAs) ? __pgliteViewAs : null,
        // A compiled handler, when this request is for one. Resolution happened
        // here because only this worker has swc, the ?st= token and the registration scope;
        // execution happens over there because only that one has a database.
        bundle: bundle || null,
      } }, [mc.port2]);
    } catch (e) { settle(null); return; }
    // Generous: the first request through a cold host pays PGlite's boot.
    timer = setTimeout(function () { settle(null); }, 30000);
  });
  if (reply) {
    return new Response(reply.body, { status: reply.status || 200, headers: reply.headers || {} });
  }
  return new Response(JSON.stringify({ error: 'Local data is still starting up' }), {
    status: 503, headers: { 'content-type': 'application/json' },
  });
}
// === end /api/data relay =====================================================================
`;
