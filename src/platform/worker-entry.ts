/**
 * worker-entry — the TRUSTED per-project workerd shim (Trivial-authored, NOT user code).
 * Productionized from the keystone spike's `src/worker.entry.js`, with the raw `ctx.sql` REMOVED.
 *
 * This is the source the bundler (`bundle.ts`) embeds as the workerd module, aliasing `virtual:handler` to
 * the user's bounded Hono handler. It builds the isolate's `ctx` from a STATIC binding (`env.GATEWAY_URL`) +
 * the PER-REQUEST single-use nonce the dispatcher injected on the inbound request. The isolate holds NO
 * Postgres host/port/credential — only an HTTP gateway URL + a one-shot nonce. Every data capability is an
 * HTTP fetch to the loopback gateway carrying the nonce.
 *
 * 🔑 STRUCTURED OPS ONLY — `ctx.list/insert/update/remove`. There is NO `ctx.sql`: the spike PROVED a
 * handler-authored single-statement `set_config` re-stamps the RLS identity GUC mid-statement and crosses
 * alice⊥bob — uncloseable at the gateway for raw SQL. The structured surface lets the gateway COMPOSE the
 * SQL (mapped to runtime-api's list/insert/update/remove), so the handler authors none and there is nowhere
 * to smuggle a `set_config`. The shim exposes no `_env`/`_nonce` escape hatches (those were spike-only probes).
 *
 * Kept as a STRING (not a `.js` asset) so it travels with the compiled TS — the bundler feeds it to esbuild
 * via stdin; no build-time asset-copy step, no `.js` in the tsc output to manage.
 */
export const WORKER_ENTRY_SOURCE = String.raw`
import { buildApp } from 'virtual:handler';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Pure-liveness route — answers WITHOUT touching the gateway/PG, so the supervisor's cold-wake
    // measurement is process-spawn → first-serving-byte.
    if (url.pathname === '/__health') return new Response('ok');

    // The single-use nonce the DISPATCHER minted + injected on THIS request. The isolate never mints (it has
    // no dispatcher endpoint reachable) — it only relays. Absent ⇒ the handler cannot reach data.
    const nonce = req.headers.get('x-trivial-nonce') || '';

    // Every data capability is one structured op = an HTTP fetch to the loopback gateway carrying the nonce.
    // The gateway authenticates the nonce, resolves (projectId, userId, role) from the MINT (never this body),
    // composes the SQL, and runs it in its own withRequest txn (the wall + RLS + caps, reused from runtime-api).
    const op = async (operation, payload) => {
      const r = await fetch(env.GATEWAY_URL + '/op', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, op: operation, ...payload }),
      });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { j = { error: text }; }
      if (!r.ok) throw new Error('gateway ' + r.status + ': ' + (j && j.error));
      return j.result;
    };

    // the curated, owner-enabled EGRESS channel. The ONLY external-call path: the global fetch is
    // guardrail-blocked in USER code, and the isolate is /32-locked to this gateway, so a handler reaches
    // an outside host ONLY through ctx.fetch → the gateway's fail-closed egress PROXY (/egress), which gates on
    // the curated allowlist + the project's owner-enabled set, then resolves+re-pins+blocks-internal before
    // forwarding. The project is identified by THIS request's nonce at the proxy — never anything the handler
    // sends. Mirrors the fetch(url, init) interface and returns a Response. (ctx.fetch is a MEMBER call, which
    // the guardrail permits — it blocks only the bare global fetch; the bare fetch below is TRUSTED shim code.)
    const egressFetch = async (input, init) => {
      const o = init || {};
      const target = typeof input === 'string' ? input
        : (input && typeof input.url === 'string' ? input.url : String(input));
      const method = o.method || (input && input.method) || 'GET';
      let headers;
      const h = o.headers || (input && input.headers);
      if (h) {
        if (typeof Headers !== 'undefined' && h instanceof Headers) { headers = {}; h.forEach((v, k) => { headers[k] = v; }); }
        else if (Array.isArray(h)) { headers = {}; for (const p of h) headers[p[0]] = p[1]; }
        else headers = h;
      }
      let body;
      const b = (o.body != null) ? o.body : (input && input.body);
      if (b != null) body = (typeof b === 'string') ? b : JSON.stringify(b);

      const r = await fetch(env.GATEWAY_URL + '/egress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: nonce, url: target, method: method, headers: headers, body: body }),
      });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { j = {}; }
      if (!r.ok || !j || j.forwarded !== true) {
        // The PROXY refused/failed (not allowlisted / not enabled / SSRF / unresolvable). FAIL-CLOSED: throw, so
        // a block can never be mistaken for the external server's own response (and no proxy body leaks through).
        throw new Error('egress blocked: ' + ((j && j.error) || ('proxy ' + r.status)));
      }
      const noBody = j.status === 204 || j.status === 205 || j.status === 304;
      return new Response(noBody ? null : (j.body != null ? j.body : ''), { status: j.status, headers: j.headers || {} });
    };

    const ctx = {
      // Structured ops — the gateway composes the SQL; the handler names only a table + values (+ id). These
      // map 1:1 onto runtime-api's list/insert/update/remove (the same code /api/data rides).
      list: (table, opts) => op('list', { table, opts }),
      insert: (table, values) => op('insert', { table, values }),
      update: (table, id, values) => op('update', { table, id, values }),
      remove: (table, id) => op('remove', { table, id }),
      // The curated egress channel — see egressFetch above. A member call (ctx.fetch), so the
      // guardrail allows it; the bare global fetch stays blocked in user handlers.
      fetch: egressFetch,
    };

    const app = buildApp(ctx);
    return app.fetch(req, env);
  },
};
`;
