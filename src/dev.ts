/**
 * `trivial dev` — the local dev loop for a cloned project ( stages 1+2).
 *
 * One process, one origin:
 *
 *     http://127.0.0.1:5173
 *       ├── /api/data/*   → THIS process: PGLite + the workshop's own dispatch bytes  (stage 1)
 *       ├── /api/<name>   → a `workerd` isolate per route, via the loopback gateway   (stage 2)
 *       └── everything    → Vite (child, internal port), incl. the HMR websocket
 *
 * Same origin is the whole trick. The vendored SDK ships `dataApiBaseUrl: ""` by deliberate design
 *, so it calls a RELATIVE
 * `/api/data/...`. Serving all three from one port means a cloned dynamic app works locally with
 * **no change to the project's source and no credential in the page** — the same reason the
 * published app works, achieved the same way.
 *
 * WHOSE CODE RUNS WHERE — the line the whole design turns on:
 *
 *   - **Data is OURS.** `dev-data-plane-node` instantiates the byte-identical sources the preview
 *     Service Worker splices, over a schema from the byte-identical compiler (`resolveBuildSchema`).
 *     It executes our code against the maker's *declared manifest*, so no maker or collaborator
 *     code runs in this process — which is why stage 1 needed no sandbox decision at all.
 *   - **Handlers are THEIRS**, and therefore run in real `workerd` (`handlers.ts`), never in this
 *     Node process. The runtime is the confinement: no ambient network, no filesystem, no
 *     `process`. A collaborator's `handlers/x.ts` cannot reach a teammate's environment because
 *     there is no environment to reach.
 *
 * LOCAL DATA IS FICTION, and now it has a better home than one browser profile: an optional
 * `.trivial/seed.json` (the shape `data.export` already emits) is applied after the schema, so a
 * team's dev fixtures are versionable, reviewable and shared by everyone who clones. Live data is
 * never fetched — not as a flag, not as an opt-in.
 *
 * BINDING: 127.0.0.1 only, and the Host header is validated. An unauthenticated local plane that
 * answered any Host would be reachable from any page the maker visits, via DNS rebinding. The
 * handler gateway binds a *separate*, dedicated loopback address (see `pickGatewayHost`) so an
 * isolate's one permitted destination is us and not everything else on the maker's localhost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadDevDataPlane, type DevDataPlane, type DevIdentity } from './platform/dev-data-plane-node.js';
import { loadDevRuntime } from './platform/dev-handler-runtime.js';
import { resolveBuildSchema } from './platform/project-manifest.js';
import { HandlerHost, NonceMint, discoverHandlers, pickGatewayHost } from './handlers.js';

/** Pinned to the version the platform's build layer runs, so local semantics match the workshop's. */
const PGLITE_VERSION = '0.5.3';

/** Where the lazily-installed runtime lives. Keeping it out of the CLI bundle is deliberate: PGLite
 *  is a WASM payload, and `clone`/`push`/`publish` must stay a one-file download. */
function runtimeDir(): string { return join(homedir(), '.trivial', 'runtime'); }

/** Install PGLite on first `trivial dev`, then require it from the runtime dir. */
async function loadPGlite(): Promise<any> {
  const dir = runtimeDir();
  const modPath = join(dir, 'node_modules', '@electric-sql', 'pglite');
  const present = await fs.access(modPath).then(() => true).catch(() => false);
  if (!present) {
    console.log(`  installing the local data runtime (once) → ${dir}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'trivial-cli-runtime', private: true }) + '\n', 'utf8');
    await new Promise<void>((resolve, reject) => {
      execFile('npm', ['install', '--silent', '--no-audit', '--no-fund', `@electric-sql/pglite@${PGLITE_VERSION}`],
        { cwd: dir, timeout: 300_000 },
        (err) => (err ? reject(new Error(`could not install the local data runtime: ${err.message}`)) : resolve()));
    });
  }
  const { createRequire } = await import('node:module');
  const req = createRequire(join(dir, 'package.json'));
  return req('@electric-sql/pglite');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Only localhost forms may address this server — the DNS-rebinding guard. */
function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

export interface DevOptions {
  folder: string;
  projectId: string;
  port: number;
  identity: DevIdentity;
  /** Extra args passed through to vite. */
  viteArgs?: string[];
}

/**
 * `trivial dev` end-user identity.
 *
 * The scaffold's `trivial-auth.ts` promises the same sign-in code works in the canvas frame and on
 * Live. It did not work HERE: `isPreview()` is false outside the canvas shell, so `signIn()`
 * navigated to `/__trivial/auth/sign-in` — a page the API serves and this dev server did not, so it
 * fell through to Vite's SPA fallback and silently re-rendered the app. Correctly-scoped data, dead
 * button, no error to search for.
 *
 * The fix lives entirely here, on purpose: `trivial-auth.ts` is VENDORED into every project, so a
 * scaffold-side change would only reach new ones. Serving the page the existing contract already
 * navigates to fixes projects that were cloned months ago, untouched.
 *
 * The token is a LOCAL FICTION and says so in its own prefix. It is not signed and grants nothing —
 * this server is 127.0.0.1-only with a validated Host header, and the identity it names is the same
 * thing `--as` names. Its only job is to survive the round trip through the browser's localStorage
 * so `trivial-data.ts` and `apiFetch` — both of which already attach `Authorization: Bearer` — carry
 * the choice back without any change to their code.
 */
const DEV_TOKEN_PREFIX = 'dev.';

/** `Authorization: Bearer dev.<b64url>` → the identity it names, or null for anything else. */
function decodeDevToken(auth: string | string[] | undefined): DevIdentity | null {
  const raw = Array.isArray(auth) ? auth[0] : auth;
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m || !m[1].startsWith(DEV_TOKEN_PREFIX)) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1].slice(DEV_TOKEN_PREFIX.length), 'base64url').toString('utf8'));
    // `sub` is the claim the VENDORED CLIENT reads (trivial-auth.ts userFromToken), so it is the
    // one the page now mints. `userId` was the pre- spelling and is still
    // accepted, so a tab left open across a `trivial update` keeps working, and so the probe's
    // hand-built legacy token still resolves.
    const claimed = typeof p?.sub === 'string' && p.sub ? p.sub
      : typeof p?.userId === 'string' && p.userId ? p.userId
      : null;
    const role = typeof p?.role === 'string' && p.role ? p.role : null;
    return { userId: claimed, role };
  } catch { return null; }
}

/** Header wins, then the signed-in dev token, then the ambient `--as` — the same precedence the
 *  data plane documents, extended by one rung so the browser's choice counts. */
function resolveDevIdentity(req: http.IncomingMessage, ambient: DevIdentity): DevIdentity {
  const hu = req.headers['x-trivial-as-user'];
  const hr = req.headers['x-trivial-as-role'];
  if ((typeof hu === 'string' && hu) || (typeof hr === 'string' && hr)) {
    return {
      userId: (typeof hu === 'string' && hu) ? hu : ambient.userId,
      role: (typeof hr === 'string' && hr) ? hr : ambient.role,
    };
  }
  return decodeDevToken(req.headers.authorization) ?? ambient;
}

/** Distinct user ids the seed already references, so the picker offers real rows rather than a
 *  blank box. Any `*_id` column that looks like an owner reference counts. */
function seededUserIds(seedTables: Array<{ table: string; rows?: Record<string, unknown>[] }>): string[] {
  const out = new Set<string>();
  for (const t of seedTables) {
    for (const row of t.rows ?? []) {
      for (const [k, v] of Object.entries(row)) {
        if (!/^(user_id|owner_id|author_id|created_by)$/i.test(k)) continue;
        if (typeof v === 'string' && v) out.add(v);
      }
    }
  }
  return [...out].sort().slice(0, 20);
}

/** The local stand-in for the hosted sign-in page. Self-contained, no network, no build step —
 *  same shape as the real one (the platform's own implementation): pick, store, go back. */
function devSignInPage(returnTo: string, users: string[], roles: string[], current: DevIdentity): string {
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  const opt = (u: string) => `<button class="u" data-u="${esc(u)}">${esc(u)}</button>`;
  return `<!doctype html><meta charset="utf-8"><title>Sign in — local dev</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0e14;color:#e6e9ef}
 main{width:min(30rem,92vw);padding:2rem;border:1px solid #232734;border-radius:12px;background:#111520}
 h1{font-size:1.1rem;margin:0 0 .25rem}
 p{color:#8b93a7;margin:0 0 1.25rem;font-size:13px}
 .row{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem}
 button{font:inherit;padding:.45rem .8rem;border-radius:7px;border:1px solid #2a3040;background:#171c28;color:#e6e9ef;cursor:pointer}
 button:hover{border-color:#3d465c}
 input,select{font:inherit;padding:.45rem .6rem;border-radius:7px;border:1px solid #2a3040;background:#0b0e14;color:#e6e9ef}
 .go{background:#2c6bed;border-color:#2c6bed}
 code{font:12px ui-monospace,monospace;color:#8b93a7}
 .note{margin-top:1.25rem;font-size:12px;color:#6b7280;border-top:1px solid #232734;padding-top:.9rem}
</style>
<main>
 <h1>Sign in — local dev</h1>
 <p>This is <code>trivial dev</code>. Pick who your app should think you are; the same button signs a real
    person in once you publish.</p>
 ${users.length ? `<div class="row">${users.map(opt).join('')}</div>` : ''}
 <div class="row">
   <input id="uid" placeholder="any user id" value="${esc(current.userId ?? '')}" style="flex:1;min-width:9rem">
   ${roles.length ? `<select id="role"><option value="">no role</option>${roles.map((r) => `<option${current.role === r ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}
   <button class="go" id="go">Sign in</button>
 </div>
 <div class="row"><button id="anon">Continue signed out</button></div>
 <p id="err" style="color:#f87171;margin:.5rem 0 0;font-size:13px"></p>
 <div class="note">Identity only — there is no password here, and nothing leaves your machine.
   <code>--as</code> sets the same thing from the command line.</div>
</main>
<script>
 const RET = ${JSON.stringify(returnTo).replace(/</g, '\\u003c')};
 function finish(userId, role) {
   try {
     if (userId) {
       // base64url by split/join, NOT by regex. This whole <script> is a template literal in
       // dev.ts, which ate the backslashes out of /\\+/g and /\\//g and shipped /+/g — an
       // "Invalid regular expression: Nothing to repeat" SyntaxError that killed the entire
       // block at parse time, so none of the listeners below ever bound and every click was a
       // no-op (the defect underneath the other two). No escapes, nothing to eat.
       var b64 = btoa(JSON.stringify({ sub: userId, role: role || null }));
       var tok = 'dev.' + b64.split('+').join('-').split('/').join('_').split('=').join('');
       // expires_at is REQUIRED by the vendored getToken(): it tests
       // \`Date.now() < t.expires_at - 30_000\`, which is NaN-false when absent, and then falls
       // through to clearTokens() — returning null AND deleting the session it just stored.
       localStorage.setItem('trivial.auth.tokens', JSON.stringify({
         access_token: tok,
         expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
       }));
       localStorage.setItem('trivial.auth.user', JSON.stringify({ id: userId, name: userId, role: role || undefined }));
     } else {
       localStorage.removeItem('trivial.auth.tokens');
       localStorage.removeItem('trivial.auth.user');
     }
   } catch (e) {
     // btoa throws on any code point above U+00FF. Say so, rather than dying silently the way
     // the SyntaxError did. (The vendored decodeJwt reads base64 as latin1, so a non-ASCII id
     // could not round-trip to the client intact even if we encoded it here.)
     document.getElementById('err').textContent =
       'Could not sign in as that id locally: ' + ((e && e.message) || e) + ' — local dev ids must be ASCII.';
     return;
   }
   location.replace(RET || '/');
 }
 document.querySelectorAll('.u').forEach((b) => b.addEventListener('click', () => finish(b.dataset.u, document.getElementById('role')?.value)));
 document.getElementById('go').addEventListener('click', () => finish(document.getElementById('uid').value.trim(), document.getElementById('role')?.value));
 document.getElementById('anon').addEventListener('click', () => finish(null, null));
</script>`;
}

/** Roles the manifest declares, for the dev sign-in picker. Read from the manifest rather
 *  than the compiled schema: `compileBuildSchema` returns `{ddl, rls, grants}` only, so asking it
 *  for roles yields undefined and an empty dropdown that looks like "this project has no roles". */
async function declaredRoles(folder: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(folder, 'src', 'trivial.manifest.json'), 'utf8');
    const m = JSON.parse(raw) as { tables?: Record<string, { role?: unknown }> };
    const out = new Set<string>();
    for (const t of Object.values(m.tables ?? {})) {
      if (t && typeof t.role === 'string' && t.role) out.add(t.role);
    }
    return [...out].sort();
  } catch { return []; }
}

/** Apply `.trivial/seed.json` if the project ships one — dev fixtures, versioned in the repo. */
async function applySeed(db: any, folder: string, collect?: { tables: Array<{ table: string; rows?: Record<string, unknown>[] }> }): Promise<number> {
  let raw: string;
  try { raw = await fs.readFile(join(folder, '.trivial', 'seed.json'), 'utf8'); } catch { return 0; }
  let parsed: { tables?: Array<{ table: string; rows?: Record<string, unknown>[] }> };
  try { parsed = JSON.parse(raw); } catch { throw new Error('.trivial/seed.json is not valid JSON'); }
  if (collect) collect.tables = parsed.tables ?? [];
  let n = 0;
  for (const t of parsed.tables ?? []) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(t.table)) continue;
    for (const row of t.rows ?? []) {
      const cols = Object.keys(row).filter((c) => /^[a-z_][a-z0-9_]{0,62}$/i.test(c));
      if (!cols.length) continue;
      const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
      const quoted = cols.map((c) => `"${c}"`).join(', ');
      await db.query(`INSERT INTO "${t.table}" (${quoted}) VALUES (${ph})`, cols.map((c) => (row as any)[c]));
      n++;
    }
  }
  return n;
}

export async function runDev(opts: DevOptions): Promise<void> {
  const { folder, projectId, port, identity } = opts;
  // Seed rows are read once for the sign-in picker — it offers ids the fixtures actually
  // reference instead of an empty text box.
  const seedCollect: { tables: Array<{ table: string; rows?: Record<string, unknown>[] }> } = { tables: [] };

  // 1. Compile the manifest with the platform's own compiler — absence means empty, exactly as the
  //    workshop and the run seam treat it, so a static project still gets a working dev server.
  const schema = await resolveBuildSchema(folder).catch((e: Error) => {
    throw new Error(`src/trivial.manifest.json — ${e.message}`);
  });

  let plane: DevDataPlane | null = null;
  let db: any = null;
  let tableCount = 0;
  let seeded = 0;

  if (schema) {
    const { PGlite } = await loadPGlite();
    db = new PGlite();
    // The role wall the generated grants target. The SW substrate ensures it the same way.
    await db.exec('CREATE ROLE app_user NOLOGIN;').catch(() => { /* already exists */ });
    await db.exec(schema.ddl);
    await db.exec(schema.rls);
    await db.exec(schema.grants);
    seeded = await applySeed(db, folder, seedCollect);
    tableCount = (schema.ddl.match(/CREATE TABLE/g) ?? []).length;
    plane = loadDevDataPlane({ db, projectId, origin: `http://127.0.0.1:${port}`, identity });
  }

  // 1b. Handlers (stage 2). The maker's own code, so it runs in real `workerd` — the runtime IS
  //     the confinement (no ambient network, no filesystem, no `process`). It reaches data only
  //     through the loopback gateway below, carrying a single-use nonce it cannot mint.
  const routes = await discoverHandlers(folder);
  const mint = new NonceMint();
  let handlerHost: HandlerHost | null = null;
  let gatewayServer: http.Server | null = null;

  if (routes.size && plane) {
    const gw = await pickGatewayHost();
    const gatewayPort = await freePort();
    const gatewayUrl = `http://${gw.host}:${gatewayPort}`;
    // The ctx verbs are the SAME bytes stage 1 serves — one implementation of list/insert/update/
    // remove, so a handler and the SDK cannot disagree about what an op means.
    const rt = loadDevRuntime();

    gatewayServer = http.createServer(async (req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let p: any = {};
      try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { error: 'bad request' }); }

      // Egress is fail-closed locally. A dev handler that reaches the internet would be a handler
      // whose behaviour depends on something the sandbox is supposed to deny; refusing
      // here keeps local and published honest with each other.
      if (req.url?.startsWith('/egress')) {
        return send(403, { error: 'egress blocked: not available in local dev' });
      }

      // IDENTITY COMES FROM THE MINT, NEVER THE BODY. This is the whole point of the nonce: the
      // isolate relays a token it was handed, it does not get to say who it is.
      const identityForOp = mint.redeem(typeof p.nonce === 'string' ? p.nonce : '');
      if (!identityForOp) return send(401, { error: 'bad or spent nonce' });

      try {
        const ctx = rt.__devMakeCtx(db, identityForOp);
        const t = String(p.table ?? '');
        let result: unknown;
        if (p.op === 'list') result = await ctx.list(t, p.opts ?? {});
        else if (p.op === 'insert') result = await ctx.insert(t, p.values ?? {});
        else if (p.op === 'update') result = await ctx.update(t, p.id, p.values ?? {});
        else if (p.op === 'remove') result = await ctx.remove(t, p.id);
        else return send(400, { error: 'unknown op' });
        return send(200, { result });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '42501') return send(403, { error: 'forbidden by data policy' });
        return send(400, { error: (e as Error).message });
      }
    });
    await new Promise<void>((r) => gatewayServer!.listen(gatewayPort, gw.host, r));
    if (!gw.narrowed) {
      console.log('  !  handler egress is pinned to 127.0.0.1/32, not a dedicated address —');
      console.log('     a handler could reach other services you have on localhost. (Linux narrows this automatically.)');
    }

    handlerHost = new HandlerHost(
      { folder, workDir: join(folder, '.trivial', 'handlers'), gatewayUrl },
      routes,
    );
  }

  // 2. Vite on an internal port; this process owns the one the maker uses.
  const vitePort = await freePort();
  const vite: ChildProcess = spawn(
    'npx', ['vite', '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1', ...(opts.viteArgs ?? [])],
    { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let viteReady = false;
  const noteVite = (buf: Buffer) => {
    const s = buf.toString();
    if (!viteReady && /ready in/i.test(s)) viteReady = true;
    if (/error|failed/i.test(s)) process.stderr.write(`  [vite] ${s.trim()}\n`);
  };
  vite.stdout?.on('data', noteVite);
  vite.stderr?.on('data', noteVite);

  // 3. The one origin. Data first, everything else proxied.
  const server = http.createServer(async (req, res) => {
    if (!hostAllowed(req.headers.host, port)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // the page `trivial-auth.ts` already navigates to. Serving it here is what makes the
    // scaffold's "build your sign-in button once" true for `trivial dev`, without touching the
    // vendored file in anyone's project.
    if (url.pathname === '/__trivial/auth/sign-in') {
      const returnTo = url.searchParams.get('return_to') || '/';
      // Same-origin returns only, decided by the URL PARSER rather than by string shape. The
      // old test (`startsWith('/') && !startsWith('//')`) admitted `/\evil.com`, which every
      // WHATWG parser normalises to `//evil.com` and resolves to http://evil.com/. That was
      // dormant only because the page's script never parsed, so nothing ever reached
      // location.replace; fixing that defect would have armed it. Mirrors the hosted page's check
      // (the platform's own implementation).
      let safeReturn = '/';
      try {
        const u = new URL(returnTo, 'http://127.0.0.1');
        if (u.origin === 'http://127.0.0.1') safeReturn = u.pathname + u.search + u.hash;
      } catch { /* unparseable — keep '/' */ }
      const html = devSignInPage(safeReturn, seededUserIds(seedCollect.tables), await declaredRoles(folder), identity);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The dev server sends no CORS headers anywhere, so this page is the one surface a
        // foreign origin could use to reach local project data. Deny framing so it cannot be
        // driven invisibly from an attacker's tab while `trivial dev` happens to be running.
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
      });
      res.end(html);
      return;
    }

    if (plane && plane.isCandidate(url)) {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        // fold the browser's signed-in choice into the header the plane already honours,
        // rather than teaching the shared canvas plane about a CLI-only token.
        const who = resolveDevIdentity(req, identity);
        const hdrs: Record<string, string> = { ...(req.headers as Record<string, string>) };
        if (who.userId) hdrs['x-trivial-as-user'] = who.userId;
        if (who.role) hdrs['x-trivial-as-role'] = who.role;
        const request = new Request(url, {
          method: req.method,
          headers: hdrs,
          ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
        });
        const out = await plane.dispatch(request, url);
        const headers: Record<string, string> = {};
        out.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(out.status, headers);
        const text = await out.text();
        res.end(text || undefined);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Data API error', detail: (e as Error).message }));
      }
      return;
    }
    // `/api/<route>` — the maker's own handler, in its isolate. The nonce is minted HERE, from the
    // identity this process decided, so the handler can act as that person and nobody else.
    const handlerMatch = /^\/api\/([^/?#]+)/.exec(url.pathname);
    const route = handlerMatch ? handlerMatch[1].toLowerCase() : '';
    if (handlerHost && handlerHost.has(route)) {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const request = new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
        });
        // Header wins, then the signed-in dev token, then the ambient `--as`.
        const who: DevIdentity = resolveDevIdentity(req, identity);
        const out = await handlerHost.dispatch(route, request, url, mint.mint(who));
        const headers: Record<string, string> = {};
        out.headers.forEach((v, k) => { if (k.toLowerCase() !== 'content-encoding') headers[k] = v; });
        res.writeHead(out.status, headers);
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'handler failed', detail: (e as Error).message }));
      }
      return;
    }
    // Everything else is Vite's.
    const proxy = http.request(
      { host: '127.0.0.1', port: vitePort, method: req.method, path: req.url, headers: req.headers },
      (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); },
    );
    proxy.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(viteReady ? 'dev server error' : 'starting…');
    });
    req.pipe(proxy);
  });

  // HMR rides a websocket; without this the page reloads but never hot-updates.
  server.on('upgrade', (req, socket, head) => {
    const up = http.request({
      host: '127.0.0.1', port: vitePort, method: req.method,
      path: req.url, headers: req.headers,
    });
    up.on('upgrade', (upRes, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n')}\r\n\r\n`);
      if (upHead?.length) socket.unshift(upHead);
      upSocket.pipe(socket).pipe(upSocket);
    });
    up.on('error', () => socket.destroy());
    if (head?.length) up.write(head);
    up.end();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  const who = identity.userId ? `${identity.userId}${identity.role ? ` (${identity.role})` : ''}` : 'anonymous';
  console.log(`\n  ➜  http://127.0.0.1:${port}`);
  if (plane) {
    console.log(`  ✓  /api/data/*   ${tableCount} table(s) from src/trivial.manifest.json${seeded ? ` · ${seeded} seeded row(s)` : ''}`);
    console.log(`     identity: ${who}   (--as <user> to change)`);
  } else {
    console.log('  ·  no src/trivial.manifest.json — no data plane (static project)');
  }
  if (handlerHost) {
    console.log(`  ✓  /api/<name>    ${handlerHost.routeNames.map((r) => '/api/' + r).join(', ')}  (workerd, started on first request)`);
  } else if (routes.size) {
    console.log(`  !  ${routes.size} handler(s) found but no src/trivial.manifest.json — declare your data first`);
  }
  console.log('\n  Ctrl+C to stop.\n');

  const stop = () => {
    try { vite.kill('SIGTERM'); } catch { /* gone */ }
    handlerHost?.stop();
    gatewayServer?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  vite.on('exit', (code) => {
    if (code && code !== 0) { console.error(`\n✗ vite exited (${code}) — is this a Trivial project folder?`); process.exit(1); }
  });
}
