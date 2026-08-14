/**
 * `trivial dev` stage 2 — the maker's own handlers, in REAL `workerd`.
 *
 * Stage 1 serves `/api/data/*` from PGLite and runs only OUR code, so it needed no sandbox. Stage 2
 * runs the MAKER'S code, and the whole reason it is `workerd` and not a Node host is that
 * **the runtime is the confinement**: no ambient network, no filesystem, no `process`. A
 * collaborator's `handlers/x.ts` cannot reach a teammate's environment, because there is no
 * environment to reach. That is the same property the published run tier relies on, achieved the
 * same way — the same binary, the same shim, the same structured-op contract.
 *
 * The four pieces, each mirroring the platform's own implementation:
 *
 *   1. BUNDLE   `handlerBundleOptions` (shared, not copied) — esbuild feeds the TRUSTED
 *               `worker-entry` shim via stdin, aliasing `virtual:handler` to the maker's module.
 *   2. CONFIG   a capnp with the bundle embedded, one loopback socket, `GATEWAY_URL` bound, and
 *               `globalOutbound` pinned to a network service that allows ONLY our gateway — so a
 *               handler's `fetch` cannot reach the internet from a maker's laptop either.
 *   3. SPAWN    `workerd serve cfg.capnp`, lazily on the first request to that route (a project
 *               with five handlers should not boot five processes to serve one page).
 *   4. GATEWAY  `/op` — the isolate holds NO database credential, only a URL and a one-shot nonce.
 *               It relays structured ops; this side authenticates the nonce, resolves the identity
 *               **from the mint, never from the body**, and runs the op against local PGLite with
 *               the same RLS discipline stage 1 uses. There is deliberately no `ctx.sql`: the
 *               structured surface is what makes "compose the SQL yourself" impossible.
 *
 * The identity mint is why a nonce exists at all. If the isolate could name its own identity, a
 * handler could claim to be anyone; instead the dispatcher decides who the request is, mints a
 * single-use nonce for that decision, and the isolate can only relay it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
// The bundle OPTIONS are shared (they are the contract with workerd — platform:'neutral', the
// `worker` condition, the `virtual:handler` alias). `bundle-options.ts` has NO esbuild value import,
// so pulling it in costs the CLI nothing; the esbuild that executes them is loaded lazily from
// ~/.trivial/runtime, because its native binary must not live in a one-file download.
import { handlerBundleOptions } from './platform/bundle-options.js';

/** Pinned like PGLite: the local runtime should not drift from the one the run tier spawns. */
const WORKERD_VERSION = '1.20260705.1';   // the version the run tier spawns (prod ~/workerd-host-bin)
const ESBUILD_VERSION = '0.28.0';   // matches api/node_modules — the bundler the publish path uses

const HANDLER_EXTS = ['.ts', '.js', '.mts', '.mjs'];

function runtimeDir(): string { return join(homedir(), '.trivial', 'runtime'); }

async function npmInstall(pkgs: string[]): Promise<void> {
  const dir = runtimeDir();
  await fs.mkdir(dir, { recursive: true });
  const pkgJson = join(dir, 'package.json');
  if (!(await fs.access(pkgJson).then(() => true).catch(() => false))) {
    await fs.writeFile(pkgJson, JSON.stringify({ name: 'trivial-cli-runtime', private: true }) + '\n', 'utf8');
  }
  await new Promise<void>((resolve, reject) => {
    execFile('npm', ['install', '--silent', '--no-audit', '--no-fund', ...pkgs], { cwd: dir, timeout: 600_000 },
      (err) => (err ? reject(new Error(`could not install the local handler runtime: ${err.message}`)) : resolve()));
  });
}

/** The `workerd` binary from the runtime dir, installing it (and esbuild) on first use. */
export async function ensureWorkerd(): Promise<string> {
  const bin = join(runtimeDir(), 'node_modules', '.bin', 'workerd');
  if (await fs.access(bin).then(() => true).catch(() => false)) return bin;
  console.log('  installing the local handler runtime (once) — workerd + esbuild');
  await npmInstall([`workerd@${WORKERD_VERSION}`, `esbuild@${ESBUILD_VERSION}`]);
  return bin;
}

/** esbuild from the runtime dir — never bundled into the CLI (it carries a native binary). */
async function runtimeEsbuild(): Promise<{ build: (o: unknown) => Promise<unknown> }> {
  const { createRequire } = await import('node:module');
  const req = createRequire(join(runtimeDir(), 'package.json'));
  return req('esbuild');
}

/** `handlers/<route>.<ext>` → `/api/<route>`, the same registry the publish path derives. */
export async function discoverHandlers(folder: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let entries: string[] = [];
  try { entries = await fs.readdir(join(folder, 'handlers')); } catch { return out; }
  for (const name of entries) {
    const ext = HANDLER_EXTS.find((e) => name.endsWith(e));
    if (!ext) continue;
    const route = name.slice(0, -ext.length).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(route)) continue;
    if (!out.has(route)) out.set(route, join(folder, 'handlers', name));
  }
  return out;
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

/**
 * Pick the gateway's bind address. Prod uses a DEDICATED loopback IP (`WORKERD_EGRESS_ALLOW=127.0.0.2/32`)
 * rather than 127.0.0.1, and the reason matters more on a laptop than on a server: `network(allow=…)`
 * is CIDR-only, so allowing 127.0.0.1/32 would also let a handler reach everything else the maker has
 * listening on localhost — their Postgres, their other dev servers, a company VPN proxy. A dedicated
 * address narrows the isolate's whole world to our gateway.
 *
 * Linux gives the entire 127.0.0.0/8 to loopback, so 127.0.0.2 just works. macOS configures only
 * 127.0.0.1 by default, so we fall back — and SAY so, because that fallback widens what a handler can
 * reach and the maker deserves to know rather than discover.
 */
export async function pickGatewayHost(): Promise<{ host: string; narrowed: boolean }> {
  const ok = await new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '127.0.0.2', () => s.close(() => resolve(true)));
  });
  return ok ? { host: '127.0.0.2', narrowed: true } : { host: '127.0.0.1', narrowed: false };
}

/** The capnp the local worker runs. Mirrors the supervisor's, minus the prod-only egress categories:
 *  a maker's dev handler may reach the gateway's /32 and nothing else. */
function capnpConfig(bundleFile: string, port: number, gatewayUrl: string, gatewayHost: string): string {
  return `using Workers = import "/workerd/workerd.capnp";
const config :Workers.Config = (
  services = [
    (name = "main", worker = .main),
    (name = "gateway", network = (allow = ["${gatewayHost}/32"]))
  ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const main :Workers.Worker = (
  compatibilityDate = "2024-11-01",
  compatibilityFlags = ["nodejs_compat"],
  modules = [ (name = "worker.js", esModule = embed "${bundleFile}") ],
  globalOutbound = "gateway",
  bindings = [
    (name = "GATEWAY_URL", text = "${gatewayUrl}")
  ],
);
`;
}

export interface HandlerHostOpts {
  folder: string;
  /** Where bundles + configs are written (gitignored, under the folder's own `.trivial/`). */
  workDir: string;
  /** `http://127.0.0.1:<port>` of this process's `/op` gateway. */
  gatewayUrl: string;
}

interface Worker { port: number; child: ChildProcess; }

export class HandlerHost {
  private workers = new Map<string, Worker>();
  private workerdBin: string | null = null;
  constructor(private opts: HandlerHostOpts, private routes: Map<string, string>) {}

  has(route: string): boolean { return this.routes.has(route); }
  get routeNames(): string[] { return [...this.routes.keys()]; }

  /** Boot a route's isolate on first use, then reuse it. */
  private async workerFor(route: string): Promise<Worker> {
    const existing = this.workers.get(route);
    if (existing && !existing.child.killed) return existing;

    this.workerdBin ??= await ensureWorkerd();
    const handlerFile = this.routes.get(route)!;
    await fs.mkdir(this.opts.workDir, { recursive: true });
    const bundleName = `worker.${route}.js`;

    // The maker's own node_modules is where `hono` et al. resolve from — the same role the /deps
    // foundation pool plays in prod.
    const eb = await runtimeEsbuild();
    await eb.build(handlerBundleOptions({
      handlerFile,
      outFile: join(this.opts.workDir, bundleName),
      resolveDir: this.opts.folder,
      nodePaths: [join(this.opts.folder, 'node_modules')],
    }));

    const port = await freePort();
    // CIDR, not host:port — `network(allow=…)` is address-based; a "host:port" pattern is rejected
    // by workerd at startup with `invalid CIDR`.
    const host = new URL(this.opts.gatewayUrl).hostname;
    const cfgPath = join(this.opts.workDir, `cfg.${route}.${port}.capnp`);
    await fs.writeFile(cfgPath, capnpConfig(bundleName, port, this.opts.gatewayUrl, host), 'utf8');

    const child = spawn(this.workerdBin!, ['serve', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString().trim();
      if (s && !/^\s*$/.test(s)) process.stderr.write(`  [handler:${route}] ${s}\n`);
    });

    // Wait for the isolate's own liveness route — spawn → first serving byte.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const ok = await fetch(`http://127.0.0.1:${port}/__health`).then((r) => r.ok).catch(() => false);
      if (ok) break;
      if (i === 99) { child.kill('SIGKILL'); throw new Error(`handler ${route} did not start`); }
    }

    const w = { port, child };
    this.workers.set(route, w);
    return w;
  }

  /** Dispatch one `/api/<route>` request into its isolate, carrying the minted nonce. */
  async dispatch(route: string, request: Request, url: URL, nonce: string): Promise<Response> {
    const w = await this.workerFor(route);
    const target = `http://127.0.0.1:${w.port}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    headers.set('x-trivial-nonce', nonce);
    headers.delete('host');
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    return fetch(target, { method: request.method, headers, ...(body ? { body } : {}) });
  }

  stop(): void {
    for (const w of this.workers.values()) { try { w.child.kill('SIGTERM'); } catch { /* gone */ } }
    this.workers.clear();
  }
}

/**
 * The nonce mint. Single-use and short-lived, exactly as in prod: the isolate relays a nonce, it
 * does not choose an identity. Resolving `(nonce → identity)` HERE is what stops a handler from
 * claiming to be someone else — the body it sends is never trusted for identity.
 */
export class NonceMint {
  private issued = new Map<string, { userId: string | null; role: string | null; at: number }>();
  mint(identity: { userId: string | null; role: string | null }): string {
    const n = randomUUID();
    this.issued.set(n, { ...identity, at: Date.now() });
    // Opportunistic sweep — a dev server should not accumulate a request's worth of state forever.
    if (this.issued.size > 512) {
      const cutoff = Date.now() - 60_000;
      for (const [k, v] of this.issued) if (v.at < cutoff) this.issued.delete(k);
    }
    return n;
  }
  /** Consume: a nonce answers exactly once. */
  redeem(n: string): { userId: string | null; role: string | null } | null {
    const hit = this.issued.get(n);
    if (!hit) return null;
    this.issued.delete(n);
    if (Date.now() - hit.at > 60_000) return null;
    return { userId: hit.userId, role: hit.role };
  }
}
