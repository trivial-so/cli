// Black-box tests of the BUILT bundle (dist/trivial.cjs) against an in-process
// mock of the folder-path API — the artifact users run, not the source. Zero
// deps (node:test + node:http). `pnpm test` builds first, so these always
// exercise the current tree. Each test gets a fresh HOME + work dir in tmp.
//
// The mock server lives in THIS process, so the CLI must always be spawned
// ASYNC (never spawnSync): a sync wait would block the event loop and the mock
// could never answer the very child it's waiting on — a guaranteed deadlock.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'trivial.cjs');

// ── mock API ────────────────────────────────────────────────────────────────
// `mock.requests` records every hit; `mock.routes` maps "METHOD path" (query
// stripped) to a handler returning [status, body]. Tests reset both. A handler
// that THROWS (e.g. a failed assert) still sends a 500 — never leave the CLI
// child hanging on an unanswered request.
const mock = { requests: [], routes: {} };
let server, API;

function route(req, body) {
  const url = new URL(req.url, 'http://x');
  mock.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null, body });
  const handler = mock.routes[`${req.method} ${url.pathname}`];
  if (!handler) return [404, { error: 'no mock route' }];
  return handler({ query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization ?? null });
}

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let status = 500; let payload = { error: 'mock handler threw' };
      try {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
        [status, payload] = route(req, body);
      } catch (e) {
        payload = { error: `mock handler threw: ${e.message}` };
      }
      // A string payload is served raw (the update tests serve a fake bundle);
      // everything else is JSON.
      if (typeof payload === 'string') {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(payload);
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  API = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { mock.requests = []; mock.routes = {}; });

// ── harness ─────────────────────────────────────────────────────────────────
const PROJECT = '019fa52a-9369-7b32-87f2-8d1be7c7be85';

function freshDirs() {
  const base = mkdtempSync(join(tmpdir(), 'trivial-cli-test-'));
  const home = join(base, 'home');
  const work = join(base, 'work');
  mkdirSync(home); mkdirSync(work);
  return { base, home, work };
}

/** Async on purpose — see the header note about the in-process mock. */
function run(args, { home, cwd, env = {}, bin = CLI }) {
  return new Promise((resolve) => {
    // BROWSER=none for EVERY invocation, not per-test.
    //
    // Two commands launch a real browser — `open` and `login`'s device flow — and a per-test opt-out
    // only covers the ones somebody remembered. It did not cover login, which opened a tab at the
    // mock server's /cli/connect on the developer's desktop (reported 2026-08-07, twice). A hermetic
    // suite must not reach out of the process it runs in, and the guard belongs at the boundary
    // where every child is spawned rather than at the call sites of the moment.
    // `...env` still comes last so an individual test can override it deliberately.
    const child = spawn('node', [bin, ...args], { cwd, env: { ...process.env, HOME: home, BROWSER: 'none', ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });
}

const readCreds = (home) => JSON.parse(readFileSync(join(home, '.trivial', 'credentials.json'), 'utf8'));
const readState = (dir) => JSON.parse(readFileSync(join(dir, '.trivial', 'state.json'), 'utf8'));
const writeCreds = (home, creds) => {
  mkdirSync(join(home, '.trivial'), { recursive: true });
  writeFileSync(join(home, '.trivial', 'credentials.json'), JSON.stringify(creds));
};
const writeState = (dir, state) => {
  mkdirSync(join(dir, '.trivial'), { recursive: true });
  writeFileSync(join(dir, '.trivial', 'state.json'), JSON.stringify(state));
};

/** A cloned-folder fixture: baseline = one committed file, credential = per-project. */
function clonedFixture(home, work, { token = 'trv_project', baseSha = 'aaaa1111' } = {}) {
  const content = '<h1>hi</h1>';
  writeFileSync(join(work, 'index.html'), content);
  const sha = createHash('sha256').update(content).digest('hex');
  writeState(work, { apiUrl: API, projectId: PROJECT, baseSha, files: { 'index.html': sha } });
  writeCreds(home, { [`${API}|${PROJECT}`]: token });
}

// ── version ─────────────────────────────────────────────────────────────────
test('--version reports the stamped version', async () => {
  const { home, work, base } = freshDirs();
  const r = await run(['--version'], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /^trivial \d+\.\d+\.\d+$/);
  rmSync(base, { recursive: true, force: true });
});

// ── login (paste form) ──────────────────────────────────────────────────────
test('login --token outside a folder saves the user-level credential', async () => {
  const { home, work, base } = freshDirs();
  const r = await run(['login', '--token', 'trv_user', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.equal(readCreds(home)[API], 'trv_user');
  rmSync(base, { recursive: true, force: true });
});

test('login --token inside a cloned folder stays project-scoped', async () => {
  const { home, work, base } = freshDirs();
  writeState(work, { apiUrl: API, projectId: PROJECT, baseSha: null, files: {} });
  const r = await run(['login', '--token', 'trv_scoped'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.equal(readCreds(home)[`${API}|${PROJECT}`], 'trv_scoped');
  assert.equal(readCreds(home)[API], undefined);
  rmSync(base, { recursive: true, force: true });
});

test('login rejects a non-trv_ paste', async () => {
  const { home, work, base } = freshDirs();
  const r = await run(['login', '--token', 'ghp_wrong', '--api', API], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /does not look like a Trivial token/);
  rmSync(base, { recursive: true, force: true });
});

// ── login (device flow) ─────────────────────────────────────────────────────
test('device login: start → poll pending → approved → credential saved', async () => {
  const { home, work, base } = freshDirs();
  let polls = 0;
  mock.routes['POST /api/cli/session/start'] = ({ body }) => {
    assert.ok(body.label.length > 0);
    return [200, { deviceCode: 'dvc_secret', userCode: 'ABCD-EFGH', verificationUri: `${API}/cli/connect`, verificationUriComplete: `${API}/cli/connect?code=ABCD-EFGH`, expiresIn: 60, interval: 1 }];
  };
  mock.routes['POST /api/cli/session/poll'] = ({ body }) => {
    assert.equal(body.deviceCode, 'dvc_secret');
    assert.equal(body.userCode, 'ABCD-EFGH');
    polls += 1;
    return polls < 2 ? [200, { status: 'pending' }] : [200, { status: 'approved', token: 'trv_minted', user: { username: 'testuser' } }];
  };
  const r = await run(['login', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /code:\s+ABCD-EFGH/);
  assert.match(r.out, /logged in as testuser/);
  assert.equal(readCreds(home)[API], 'trv_minted');
  assert.ok(polls >= 2);
  rmSync(base, { recursive: true, force: true });
});

test('device login dies cleanly when the code expires (poll 404)', async () => {
  const { home, work, base } = freshDirs();
  mock.routes['POST /api/cli/session/start'] = () => [200, { deviceCode: 'dvc_x', userCode: 'AAAA-BBBB', verificationUri: `${API}/cli/connect`, verificationUriComplete: `${API}/cli/connect?code=AAAA-BBBB`, expiresIn: 60, interval: 1 }];
  mock.routes['POST /api/cli/session/poll'] = () => [404, { error: 'expired' }];
  const r = await run(['login', '--api', API], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /sign-in expired/);
  assert.ok(!existsSync(join(home, '.trivial', 'credentials.json')));
  rmSync(base, { recursive: true, force: true });
});

test('login is idempotent: a working credential short-circuits the device flow', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_live' });
  mock.routes['GET /api/cli/whoami'] = () => [200, { user: { id: '1', username: 'testuser', name: null } }];
  const r = await run(['login', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already logged in as testuser/);
  assert.equal(mock.requests.filter((q) => q.path === '/api/cli/session/start').length, 0);
  rmSync(base, { recursive: true, force: true });
});

test('bare --token reads TRIVIAL_TOKEN so the secret stays out of argv/history', async () => {
  const { home, work, base } = freshDirs();
  const r = await run(['login', '--token', '--api', API], { home, cwd: work, env: { TRIVIAL_TOKEN: 'trv_from_env' } });
  assert.equal(r.code, 0, r.out);
  assert.equal(readCreds(home)[API], 'trv_from_env');
  rmSync(base, { recursive: true, force: true });
});

// ── credential resolution ───────────────────────────────────────────────────
test('narrow-wins: a per-project token beats the user-level login in its folder', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work, { token: 'trv_narrow' });
  writeCreds(home, { [`${API}|${PROJECT}`]: 'trv_narrow', [API]: 'trv_broad' });
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = ({ auth }) => {
    assert.equal(auth, 'Bearer trv_narrow');
    return [200, { head: 'aaaa1111', rebuilt: false, truncated: false, files: [] }];
  };
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.equal(mock.requests.filter((q) => q.path.endsWith('/changes')).length, 1);
  rmSync(base, { recursive: true, force: true });
});

test('user-level login is the fallback when no project token exists', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeCreds(home, { [API]: 'trv_broad' });
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = ({ auth }) => {
    assert.equal(auth, 'Bearer trv_broad');
    return [200, { head: 'aaaa1111', rebuilt: false, truncated: false, files: [] }];
  };
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  rmSync(base, { recursive: true, force: true });
});

// ── clone ───────────────────────────────────────────────────────────────────
function mockResolveAndChanges() {
  mock.routes['GET /api/cli/project'] = ({ query }) => {
    if (query.id) return [200, { id: PROJECT, owner: 'alice', slug: 'shop', name: 'Shop', role: 'owner' }];
    if (query.owner === 'alice' && query.slug === 'shop') return [200, { id: PROJECT, owner: 'alice', slug: 'shop', name: 'Shop', role: 'owner' }];
    return [404, { error: 'Project not found' }];
  };
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, {
    head: 'headsha1', rebuilt: false, truncated: false,
    files: [{ path: 'index.html', status: 'added', content: '<h1>shop</h1>' }, { path: 'src/app.tsx', status: 'added', content: 'export default 1' }],
  }];
}

test('clone owner/slug with the login credential', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad' });
  mockResolveAndChanges();
  const r = await run(['clone', 'alice/shop', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cloned alice\/shop → shop\//);
  assert.equal(readFileSync(join(work, 'shop', 'index.html'), 'utf8'), '<h1>shop</h1>');
  assert.equal(readFileSync(join(work, 'shop', 'src', 'app.tsx'), 'utf8'), 'export default 1');
  const state = readState(join(work, 'shop'));
  assert.equal(state.projectId, PROJECT);
  assert.equal(state.ref, 'alice/shop');
  assert.equal(state.baseSha, 'headsha1');
  rmSync(base, { recursive: true, force: true });
});

test('clone carries the .git repo, and states the cloud baseline from HEAD', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad' });
  mockResolveAndChanges();
  const remote = serverRepo(base, 'alice', 'shop', { 'index.html': '<h1>shop</h1>', 'src/app.tsx': 'export default 1' });

  const r = await run(['clone', 'alice/shop', '--api', API, '--git-url', serverGitUrl(base)], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /with history/);

  // The point of the change: history on the maker's machine.
  assert.ok(existsSync(join(work, 'shop', '.git')), 'the clone has no .git');
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: join(work, 'shop') }).toString().trim();
  assert.equal(log, 'baseline: scaffold');
  assert.equal(readFileSync(join(work, 'shop', 'index.html'), 'utf8'), '<h1>shop</h1>');

  // …without giving up anything the folder path provides.
  const state = readState(join(work, 'shop'));
  assert.equal(state.projectId, PROJECT);
  assert.equal(state.ref, 'alice/shop');
  assert.equal(state.baseSha, repoHead(remote), 'baseSha must be the cloned HEAD, or the first pull re-syncs the world');
  assert.ok(state.files['index.html'], 'the local baseline is missing a cloned file');
  assert.ok(state.cloud.includes('src/app.tsx'), 'cloud provenance must be git\'s tracked set');
  // A file the CLI synthesized is baselined but is NOT cloud provenance — else the next full
  // re-sync would prune it as "the cloud dropped it".
  assert.ok(state.files['src/trivial.config.json'], 'the synthesized config must be baselined');
  assert.ok(!state.cloud.includes('src/trivial.config.json'), 'a local file must never claim cloud provenance');

  // The remote is named the way every doc and `trivial init` name it.
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'trivial'], { cwd: join(work, 'shop') }).toString().trim();
  assert.equal(remoteUrl, `${serverGitUrl(base)}/alice/shop`);
  // The credential helper is wired for the folder, and carries no token.
  const cfg = readFileSync(join(work, 'shop', '.git', 'config'), 'utf8');
  assert.ok(!/trv_/.test(cfg), 'a token must never land in .git/config');
  // BOTH helper forms: the portable one that survives a reinstall, and the self-referential
  // backstop for a maker whose PATH does not have `trivial` — the case that produced a
  // history-less clone against production before it existed.
  assert.match(cfg, /helper = !trivial git-credential/);
  assert.match(cfg, new RegExp(`helper = !'[^']*node[^']*' '[^']*' git-credential`));

  // The feed was not used — that is the whole point.
  assert.ok(!mock.requests.some((q) => q.path.endsWith('/changes')), 'the git clone still hit the change feed');
  rmSync(base, { recursive: true, force: true });
});

test('a project with no git repo yet falls back to the snapshot instead of failing', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad' });
  mockResolveAndChanges();
  // A git base that resolves to nothing: the clone fails, the feed answers.
  const r = await run(['clone', 'alice/shop', '--api', API, '--git-url', `file://${join(base, 'no-such-git')}`], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no git history in this clone/);
  assert.match(r.out, /cloned alice\/shop → shop\//);
  assert.ok(!existsSync(join(work, 'shop', '.git')));
  assert.equal(readFileSync(join(work, 'shop', 'index.html'), 'utf8'), '<h1>shop</h1>');
  assert.equal(readState(join(work, 'shop')).baseSha, 'headsha1');
  rmSync(base, { recursive: true, force: true });
});

test('create carries the .git repo of the project it just scaffolded', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  mock.routes['POST /api/sites'] = () => [201, { site: { id: 'site-1', project_id: PROJECT, project_slug: 'untitled-7', handle: 'h' } }];
  mock.routes[`PATCH /api/projects/${PROJECT}`] = ({ body }) => [200, { project: { slug: body.slug } }];
  mock.routes['GET /api/cli/whoami'] = () => [200, { user: { id: 'u1', username: 'dev', name: 'Dev' } }];
  // Answered but distinguishable: if the git path silently stops running, this file appears and the
  // assertions below say which path ran rather than just "something is missing".
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, {
    head: 'feedsha', rebuilt: false, truncated: false,
    files: [{ path: 'CAME-FROM-THE-FEED.txt', status: 'added', content: 'x' }],
  }];
  const remote = serverRepo(base, 'dev', 'shop', { 'index.html': '<h1>scaffold</h1>' });

  const r = await run(['create', 'shop', '--api', API, '--git-url', serverGitUrl(base)], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /with history/);
  assert.ok(existsSync(join(work, 'shop', '.git')), 'a freshly created project must arrive with its history too');
  assert.ok(!existsSync(join(work, 'shop', 'CAME-FROM-THE-FEED.txt')), 'create fell back to the feed');
  assert.equal(readState(join(work, 'shop')).baseSha, repoHead(remote));
  // The next-steps block is the same one the snapshot path prints — one voice, two transports.
  assert.match(r.out, /trivial publish/);
  rmSync(base, { recursive: true, force: true });
});

test('--no-git takes the snapshot path deliberately', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad' });
  mockResolveAndChanges();
  serverRepo(base, 'alice', 'shop', { 'index.html': '<h1>shop</h1>' });
  const r = await run(['clone', 'alice/shop', '--api', API, '--git-url', serverGitUrl(base), '--no-git'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(work, 'shop', '.git')));
  // Silent: opting out is not a degradation, so it does not get the fallback note.
  assert.ok(!/no git history/.test(r.out), r.out);
  rmSync(base, { recursive: true, force: true });
});

test('an empty clone explains that the history has not materialized', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad' });
  mock.routes['GET /api/cli/project'] = () => [200, { id: PROJECT, owner: 'alice', slug: 'shop', name: 'Shop', role: 'owner' }];
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, { head: null, rebuilt: false, truncated: false, files: [] }];
  const r = await run(['clone', 'alice/shop', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no synced history yet/);
  rmSync(base, { recursive: true, force: true });
});

test('status shows the owner/slug ref, and open prints the project URL', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  const withRef = { ...readState(work), ref: 'alice/shop' };
  writeState(work, withRef);
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, { head: 'aaaa1111', rebuilt: false, truncated: false, files: [] }];
  const st = await run(['status'], { home, cwd: work });
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /project alice\/shop/);
  // BROWSER=none so this asserts the printed URL WITHOUT launching a real browser tab on the
  // machine running the suite — which it did, at a mock server, until 2026-08-07.
  const op = await run(['open'], { home, cwd: work, env: { BROWSER: 'none' } });
  assert.equal(op.code, 0, op.out);
  assert.match(op.out, new RegExp(`http://127\\.0\\.0\\.1:\\d+/alice/shop`)); // apiUrl has no "api." host part in tests
  rmSync(base, { recursive: true, force: true });
});

test('clone accepts a project URL and a bare uuid as the ref', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad' });
  mockResolveAndChanges();
  const byUrl = await run(['clone', 'https://trivial.so/alice/shop', 'from-url', '--api', API], { home, cwd: work });
  assert.equal(byUrl.code, 0, byUrl.out);
  assert.ok(existsSync(join(work, 'from-url', 'index.html')));
  const byId = await run(['clone', PROJECT, 'from-id', '--api', API], { home, cwd: work });
  assert.equal(byId.code, 0, byId.out);
  assert.equal(mock.requests.filter((q) => q.path === '/api/cli/project' && q.query.id === PROJECT).length, 1);
  rmSync(base, { recursive: true, force: true });
});

test('clone without a login points at trivial login', async () => {
  const { home, work, base } = freshDirs();
  mockResolveAndChanges();
  const r = await run(['clone', 'alice/shop', '--api', API], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /not logged in — run `trivial login`/);
  rmSync(base, { recursive: true, force: true });
});

test('legacy clone --project --token still works and stores the scoped credential', async () => {
  const { home, work, base } = freshDirs();
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = ({ auth }) => {
    assert.equal(auth, 'Bearer trv_pasted');
    return [200, { head: 'h1', rebuilt: false, truncated: false, files: [{ path: 'a.txt', status: 'added', content: 'a' }] }];
  };
  const r = await run(['clone', '--project', PROJECT, '--token', 'trv_pasted', '--api', API, 'legacy-dir'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(work, 'legacy-dir', 'a.txt')));
  assert.equal(readCreds(home)[`${API}|${PROJECT}`], 'trv_pasted');
  rmSync(base, { recursive: true, force: true });
});

// ── push ────────────────────────────────────────────────────────────────────
test('push sends the local diff and advances the baseline', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');
  writeFileSync(join(work, 'new.css'), 'body{}');
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = ({ body }) => {
    assert.equal(body.baseSha, 'aaaa1111');
    const paths = body.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['index.html', 'new.css']);
    return [200, { commit: 'bbbb2222' }];
  };
  const r = await run(['push', '-m', 'edit'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pushed 2 write\(s\), 0 delete\(s\)/);
  assert.equal(readState(work).baseSha, 'bbbb2222');
  rmSync(base, { recursive: true, force: true });
});

// `pnpm-lock.yaml` ships in the clone, any `pnpm install` rewrites it, and the server's
// write path refuses it (system-paths.ts). Because the write-set is validate-all-then-write-all,
// bundling it rejects the WHOLE push: a legitimate source
// edit sent alongside a touched lockfile never landed, under a message that didn't name the file.
// So the CLI partitions platform-managed paths out — and must SAY so, never drop them silently.
test('push skips platform-managed files and still lands the real edit', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'pnpm-lock.yaml'), 'lockfileVersion: rewritten-by-pnpm-install\n');
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = ({ body }) => {
    // The lockfile must never reach the server — its presence is what rejected the whole set.
    assert.deepEqual(body.files.map((f) => f.path).sort(), ['index.html']);
    return [200, { commit: 'dddd4444' }];
  };
  const r = await run(['push', '-m', 'edit'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not pushing 1 platform-managed file\(s\): pnpm-lock\.yaml/);
  assert.match(r.out, /pushed 1 write\(s\), 0 delete\(s\)/);
  rmSync(base, { recursive: true, force: true });
});

test('status reports platform-managed changes separately rather than hiding them', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'pnpm-lock.yaml'), 'lockfileVersion: rewritten\n');
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, { head: 'aaaa1111', files: [] }];
  const r = await run(['status'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /local\s+0 changed/);
  assert.match(r.out, /platform-managed, never pushed: pnpm-lock\.yaml/);
  rmSync(base, { recursive: true, force: true });
});

test('push sends deletes for files removed locally', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  rmSync(join(work, 'index.html'));
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = ({ body }) => {
    assert.deepEqual(body.files, [{ path: 'index.html', op: 'delete' }]);
    return [200, { commit: 'cccc3333' }];
  };
  const r = await run(['push'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pushed 0 write\(s\), 1 delete\(s\)/);
  rmSync(base, { recursive: true, force: true });
});

test('push 409 (cloud moved) tells the user to pull first and keeps the baseline', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = () => [409, { error: 'stale' }];
  const r = await run(['push'], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /run `trivial pull` first/);
  assert.equal(readState(work).baseSha, 'aaaa1111');
  rmSync(base, { recursive: true, force: true });
});

test("push 403 for a viewer explains the role and points at trivial propose", async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = () => [403, { error: 'You do not have edit access' }];
  const r = await run(['push'], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /You do not have edit access/);
  assert.match(r.out, /view access.*trivial propose/s);
  rmSync(base, { recursive: true, force: true });
});

test('push 403 requires_review points at trivial propose', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = () => [403, { error: 'requires_review', message: 'this project requires review' }];
  const r = await run(['push'], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /trivial propose/);
  rmSync(base, { recursive: true, force: true });
});

// ── pull ────────────────────────────────────────────────────────────────────
test('pull refuses to clobber a locally-edited file, applies it with --force', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>local edit</h1>');
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, {
    head: 'dddd4444', rebuilt: false, truncated: false,
    files: [{ path: 'index.html', status: 'modified', content: '<h1>cloud edit</h1>' }],
  }];
  const conflict = await run(['pull'], { home, cwd: work });
  assert.equal(conflict.code, 1);
  assert.match(conflict.out, /changed on both sides/);
  assert.equal(readFileSync(join(work, 'index.html'), 'utf8'), '<h1>local edit</h1>');
  const forced = await run(['pull', '--force'], { home, cwd: work });
  assert.equal(forced.code, 0, forced.out);
  assert.equal(readFileSync(join(work, 'index.html'), 'utf8'), '<h1>cloud edit</h1>');
  assert.equal(readState(work).baseSha, 'dddd4444');
  rmSync(base, { recursive: true, force: true });
});

test('pull applies remote deletes', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, {
    head: 'eeee5555', rebuilt: false, truncated: false,
    files: [{ path: 'index.html', status: 'deleted' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(work, 'index.html')));
  assert.deepEqual(readState(work).files, {});
  rmSync(base, { recursive: true, force: true });
});

// ── propose ─────────────────────────────────────────────────────────────────
test('propose sends the diff for review and does NOT advance the baseline', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>suggested</h1>');
  mock.routes[`POST /api/projects/${PROJECT}/proposals`] = ({ body }) => {
    assert.equal(body.files.length, 1);
    return [201, { id: 'refs/proposals/bob/tidy' }];
  };
  const r = await run(['propose', '-m', 'tidy'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /proposed 1 change\(s\)/);
  assert.equal(readState(work).baseSha, 'aaaa1111'); // still differs from the cloud until accepted
  rmSync(base, { recursive: true, force: true });
});

// ── status · projects · whoami · logout ─────────────────────────────────────
test('status reports the local diff and cloud-ahead count', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'extra.txt'), 'x');
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, {
    head: 'ffff6666', rebuilt: false, truncated: false,
    files: [{ path: 'other.txt', status: 'added', content: 'y' }],
  }];
  const r = await run(['status'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /local\s+1 changed, 0 deleted/);
  assert.match(r.out, /cloud\s+1 change\(s\) to pull/);
  rmSync(base, { recursive: true, force: true });
});

test('projects lists refs with roles via the login credential', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad' });
  mock.routes['GET /api/cli/projects'] = () => [200, { projects: [
    { id: PROJECT, owner: 'alice', slug: 'shop', name: 'Shop', role: 'owner', updated_at: 'x' },
    { id: '2', owner: 'bob', slug: 'blog', name: 'Blog', role: 'viewer', updated_at: 'x' },
  ] }];
  const r = await run(['projects', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /alice\/shop\s+owner\s+Shop/);
  assert.match(r.out, /bob\/blog\s+viewer\s+Blog/);
  rmSync(base, { recursive: true, force: true });
});

test('logout revokes server-side and forgets the local credential', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_broad', [`${API}|${PROJECT}`]: 'trv_narrow' });
  mock.routes['POST /api/cli/logout'] = ({ auth }) => {
    assert.equal(auth, 'Bearer trv_broad');
    return [200, { revoked: true }];
  };
  const r = await run(['logout', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  const creds = readCreds(home);
  assert.equal(creds[API], undefined);
  assert.equal(creds[`${API}|${PROJECT}`], 'trv_narrow'); // project tokens are not logout's business
  rmSync(base, { recursive: true, force: true });
});

test('re-login revokes the credential it replaces', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_old' });
  mock.routes['POST /api/cli/session/start'] = () => [200, { deviceCode: 'dvc_r', userCode: 'CCCC-DDDD', verificationUri: `${API}/cli/connect`, verificationUriComplete: `${API}/cli/connect?code=CCCC-DDDD`, expiresIn: 60, interval: 1 }];
  mock.routes['POST /api/cli/session/poll'] = () => [200, { status: 'approved', token: 'trv_new', user: { username: 'testuser' } }];
  mock.routes['POST /api/cli/logout'] = ({ auth }) => {
    assert.equal(auth, 'Bearer trv_old'); // the REPLACED key gets revoked, not the new one
    return [200, { revoked: true }];
  };
  const r = await run(['login', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.equal(readCreds(home)[API], 'trv_new');
  assert.equal(mock.requests.filter((q) => q.path === '/api/cli/logout').length, 1);
  rmSync(base, { recursive: true, force: true });
});

// ── update ──────────────────────────────────────────────────────────────────
const PKG_VERSION = JSON.parse(readFileSync(join(dirname(CLI), '..', 'package.json'), 'utf8')).version;

test('update: already up to date when the manifest matches', async () => {
  const { home, work, base } = freshDirs();
  mock.routes['GET /cli/version.json'] = () => [200, { version: PKG_VERSION }];
  const r = await run(['update'], { home, cwd: work, env: { TRIVIAL_CLI_DIST: `${API}/cli` } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already up to date/);
  assert.equal(mock.requests.filter((q) => q.path === '/cli/trivial.js').length, 0); // no needless download
  rmSync(base, { recursive: true, force: true });
});

test('update: a newer manifest replaces the installed script in place', async () => {
  const { home, work, base } = freshDirs();
  // Run a COPY as the "installed" script so dist/ itself is never clobbered.
  const installed = join(base, 'installed-trivial');
  writeFileSync(installed, readFileSync(CLI));
  const fakeBundle = `#!/usr/bin/env node\n// trivial 99.0.0 (test fixture)\n${'/* pad */'.repeat(200)}`;
  mock.routes['GET /cli/version.json'] = () => [200, { version: '99.0.0' }];
  mock.routes['GET /cli/trivial.js'] = () => [200, fakeBundle];
  const r = await run(['update'], { home, cwd: work, env: { TRIVIAL_CLI_DIST: `${API}/cli` }, bin: installed });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /updated trivial \d+\.\d+\.\d+ → 99\.0\.0/);
  assert.equal(readFileSync(installed, 'utf8'), fakeBundle);
  rmSync(base, { recursive: true, force: true });
});

// ── uninstall ───────────────────────────────────────────────────────────────
test('uninstall --yes revokes logins, keeps project tokens valid, removes creds + binary', async () => {
  const { home, work, base } = freshDirs();
  const installed = join(base, 'installed-trivial');
  writeFileSync(installed, readFileSync(CLI));
  writeCreds(home, { [API]: 'trv_login', [`${API}|${PROJECT}`]: 'trv_ci' });
  const revoked = [];
  mock.routes['POST /api/cli/logout'] = ({ auth }) => { revoked.push(auth); return [200, { revoked: true }]; };
  const r = await run(['uninstall', '--yes'], { home, cwd: work, bin: installed });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(revoked, ['Bearer trv_login']); // the login — never the project token
  assert.match(r.out, /signed out of/);
  assert.match(r.out, /project token\(s\).*stay valid elsewhere/);
  assert.match(r.out, /left untouched/);
  assert.ok(!existsSync(join(home, '.trivial')));
  assert.ok(!existsSync(installed));
  rmSync(base, { recursive: true, force: true });
});

test('uninstall refuses without --yes when stdin is not a terminal', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_login' });
  const r = await run(['uninstall'], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /--yes/);
  assert.ok(existsSync(join(home, '.trivial', 'credentials.json'))); // nothing removed
  rmSync(base, { recursive: true, force: true });
});

test('revoked credential (401) surfaces the re-login hint', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_dead' });
  mock.routes['GET /api/cli/whoami'] = () => [401, { error: 'Invalid API key' }];
  const r = await run(['whoami', '--api', API], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /Run `trivial login` again/);
  rmSync(base, { recursive: true, force: true });
});

// ── proposals: the RECEIVING half ────────────────────────────────
// `propose` could send and nothing could receive. These pin the four verbs against the mock, plus
// the two behaviours that are judgement rather than plumbing: a conflict is REPORTED (not swallowed
// into a generic failure), and rejecting — which deletes someone else's work — refuses to happen
// silently without a TTY.

const PROPOSALS = [
  { id: 'alice/fix-header', headSha: 'bbbb2222', author: 'alice', createdAt: new Date(Date.now() - 7200_000).toISOString(), subject: 'fix: header wraps on mobile' },
  { id: 'bob/add-search', headSha: 'cccc3333', author: 'bob', createdAt: new Date(Date.now() - 90_000_000).toISOString(), subject: 'feat: search box' },
];
const proposalRoutes = () => {
  mock.routes[`GET /api/projects/${PROJECT}/proposals`] = () => [200, { proposals: PROPOSALS }];
};

test('proposals lists what is waiting, newest details and all', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  const r = await run(['proposals'], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /2 proposal\(s\)/);
  assert.match(r.out, /alice\/fix-header/);
  assert.match(r.out, /fix: header wraps on mobile/);
  assert.match(r.out, /alice · 2h ago/);
  rmSync(base, { recursive: true, force: true });
});

test('proposals says so plainly when there are none', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  mock.routes[`GET /api/projects/${PROJECT}/proposals`] = () => [200, { proposals: [] }];
  const r = await run(['proposals'], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /no proposals/);
  rmSync(base, { recursive: true, force: true });
});

test('review renders an actual line diff, not a file list', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  mock.routes[`GET /api/projects/${PROJECT}/proposals/diff`] = ({ query }) => {
    assert.equal(query.id, 'alice/fix-header');   // the slash must survive the round trip
    return [200, {
      base: 'aaaa1111', head: 'bbbb2222',
      files: [{ path: 'src/App.tsx', status: 'modified', before: 'a\nb\nc\n', after: 'a\nB!\nc\n' }],
    }];
  };
  const r = await run(['review', 'alice/fix-header'], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /M src\/App\.tsx {2}\+1 −1/);
  assert.match(r.out, /- b/);
  assert.match(r.out, /\+ B!/);
  assert.match(r.out, / {2}a$/m);                 // context is shown, unprefixed
  rmSync(base, { recursive: true, force: true });
});

test('a partial id resolves; an ambiguous one refuses rather than guessing', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  mock.routes[`GET /api/projects/${PROJECT}/proposals/diff`] = () => [200, { base: 'a', head: 'b', files: [] }];
  const ok = await run(['review', 'header'], { home, cwd: work });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /alice\/fix-header/);

  // 'a' appears in both ids — accepting the wrong person's change is not a recoverable mistake.
  const ambiguous = await run(['review', 'a'], { home, cwd: work });
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.out, /matches 2 proposals/);
  rmSync(base, { recursive: true, force: true });
});

test('accept applies, and says the folder is now behind', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  mock.routes[`POST /api/projects/${PROJECT}/proposals/accept`] = ({ body }) => {
    assert.equal(body.id, 'alice/fix-header');
    return [200, { accepted: true, applied: 3 }];
  };
  const r = await run(['accept', 'fix-header'], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /accepted alice\/fix-header — 3 file\(s\)/);
  // Without this the next push looks like a conflict for no visible reason.
  assert.match(r.out, /trivial pull/);
  rmSync(base, { recursive: true, force: true });
});

test('a real conflict is REPORTED with its files, not flattened to "failed"', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  mock.routes[`POST /api/projects/${PROJECT}/proposals/accept`] = () => [409, {
    status: 'conflict', files: ['src/App.tsx'], hint: 'pull it on your laptop and rebase.',
  }];
  const r = await run(['accept', 'fix-header'], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /conflicts with Draft in 1 file/);
  assert.match(r.out, /src\/App\.tsx/);
  assert.match(r.out, /rebase/);
  rmSync(base, { recursive: true, force: true });
});

test('accept without edit access explains WHO can, not just 403', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  mock.routes[`POST /api/projects/${PROJECT}/proposals/accept`] = () => [403, { error: 'You do not have edit access' }];
  const r = await run(['accept', 'fix-header'], { home, cwd: work });
  assert.equal(r.code, 1);
  assert.match(r.out, /edit access/);
  rmSync(base, { recursive: true, force: true });
});

test('reject refuses to delete non-interactively without --yes', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  let called = false;
  mock.routes[`POST /api/projects/${PROJECT}/proposals/reject`] = () => { called = true; return [200, { rejected: true }]; };
  const r = await run(['reject', 'fix-header'], { home, cwd: work });   // stdin is not a TTY here
  assert.equal(r.code, 1);
  assert.match(r.out, /--yes/);
  assert.equal(called, false, 'it must not have deleted anything');
  rmSync(base, { recursive: true, force: true });
});

test('reject --yes deletes it', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  proposalRoutes();
  mock.routes[`POST /api/projects/${PROJECT}/proposals/reject`] = ({ body }) => {
    assert.equal(body.id, 'alice/fix-header');
    return [200, { rejected: true }];
  };
  const r = await run(['reject', 'fix-header', '--yes'], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /rejected alice\/fix-header/);
  rmSync(base, { recursive: true, force: true });
});

// ── git credential helper ───────────────────────────────────────────────────
// So nobody ever pastes a token into a remote URL. git invokes this, not a human: it writes a
// request on stdin and reads username/password on stdout. The behaviour that matters most is the
// SILENCE — for any host we don't serve it must print nothing and exit 0, or configuring it
// globally would break every other git remote on the machine.

/** Run the CLI with stdin, since git talks to the helper over a pipe. */
function runWithStdin(args, { home, cwd, stdin }) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env: { ...process.env, HOME: home } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

test('git-credential get: serves the login token for our git host', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { 'https://api.trivial.so': 'trv_login_token' });
  const r = await runWithStdin(['git-credential', 'get'], {
    home, cwd: work, stdin: 'protocol=https\nhost=git.trivial.so\npath=alice/app\n\n',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /^username=x-access-token$/m);
  assert.match(r.out, /^password=trv_login_token$/m);
  rmSync(base, { recursive: true, force: true });
});

test('git-credential get: SILENT for a host we do not serve', async () => {
  // The load-bearing case. A helper configured globally that answered for github.com would hand
  // someone else our token; one that errored would break their unrelated pushes.
  const { home, work, base } = freshDirs();
  writeCreds(home, { 'https://api.trivial.so': 'trv_login_token' });
  const r = await runWithStdin(['git-credential', 'get'], {
    home, cwd: work, stdin: 'protocol=https\nhost=github.com\n\n',
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '');
  rmSync(base, { recursive: true, force: true });
});

test('git-credential get: silent when nobody is logged in', async () => {
  const { home, work, base } = freshDirs();
  const r = await runWithStdin(['git-credential', 'get'], {
    home, cwd: work, stdin: 'protocol=https\nhost=git.trivial.so\n\n',
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '');
  rmSync(base, { recursive: true, force: true });
});

test('git-credential get: matches a local mirror on its own domain + port', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { 'https://example.test:3030': 'trv_mirror' });
  const r = await runWithStdin(['git-credential', 'get'], {
    home, cwd: work, stdin: 'protocol=https\nhost=git.example.test:3443\n\n',
  });
  assert.match(r.out, /^password=trv_mirror$/m);
  rmSync(base, { recursive: true, force: true });
});

test('git-credential get: ignores per-project keys — a login is what it serves', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [`https://api.trivial.so|${PROJECT}`]: 'trv_project_scoped' });
  const r = await runWithStdin(['git-credential', 'get'], {
    home, cwd: work, stdin: 'protocol=https\nhost=git.trivial.so\n\n',
  });
  assert.equal(r.out.trim(), '');
  rmSync(base, { recursive: true, force: true });
});

test('git-credential store/erase are no-ops — the login belongs to login/logout', async () => {
  // A helper that erased the credential because one push 401'd would sign the maker out of
  // everything, which is a genuinely bad surprise for an unrelated failure.
  const { home, work, base } = freshDirs();
  writeCreds(home, { 'https://api.trivial.so': 'trv_login_token' });
  for (const verb of ['store', 'erase']) {
    const r = await runWithStdin(['git-credential', verb], {
      home, cwd: work, stdin: 'protocol=https\nhost=git.trivial.so\npassword=trv_login_token\n\n',
    });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), '');
  }
  assert.equal(readCreds(home)['https://api.trivial.so'], 'trv_login_token');
  rmSync(base, { recursive: true, force: true });
});

test('git-credential get: refuses a non-https protocol', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { 'https://api.trivial.so': 'trv_login_token' });
  const r = await runWithStdin(['git-credential', 'get'], {
    home, cwd: work, stdin: 'protocol=http\nhost=git.trivial.so\n\n',
  });
  assert.equal(r.out.trim(), '');
  rmSync(base, { recursive: true, force: true });
});

// ──  — binary files travel faithfully ──────────────────────────────────
// A JSON string cannot carry raw bytes: before the encoding field, a pushed
// PNG arrived UTF-8-mangled (the docs screenshots shipped 234 KB → 418 KB of
// noise) and a pulled one corrupted the same way. Binary = git's heuristic
// (NUL in the first 8000 bytes) → base64 + `encoding: 'base64'`, both
// directions; text files stay byte-identical plain strings.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR (with NULs)
  0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0x00, 0x9d, // high bytes that utf8 mangles
]);

test('push sends a binary file as base64 with encoding, text stays plain', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'logo.png'), PNG_BYTES);
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = ({ body }) => {
    const png = body.files.find((f) => f.path === 'logo.png');
    const html = body.files.find((f) => f.path === 'index.html');
    assert.equal(png.encoding, 'base64');
    assert.deepEqual(Buffer.from(png.content, 'base64'), PNG_BYTES);
    assert.equal(html.encoding, undefined);
    assert.equal(html.content, '<h1>edited</h1>');
    return [200, { commit: 'bbbb2222' }];
  };
  const r = await run(['push', '-m', 'binary'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  rmSync(base, { recursive: true, force: true });
});

test('pull decodes a base64 file to exact bytes and baselines those bytes', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, {
    head: 'cccc3333', rebuilt: false, truncated: false,
    files: [{ path: 'logo.png', status: 'added', content: PNG_BYTES.toString('base64'), encoding: 'base64' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readFileSync(join(work, 'logo.png')), PNG_BYTES);
  // the baseline hash must be of the DECODED bytes — a follow-up status must see no local change
  assert.equal(readState(work).files['logo.png'], createHash('sha256').update(PNG_BYTES).digest('hex'));
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, { head: 'cccc3333', rebuilt: false, truncated: false, files: [] }];
  const s = await run(['status'], { home, cwd: work });
  assert.match(s.out, /local\s+0 changed/, s.out);
  rmSync(base, { recursive: true, force: true });
});

test('push refuses an oversized binary by name instead of an opaque 413', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  const big = Buffer.alloc(8 * 1024 * 1024); // NULs → binary, over the ~7 MB wire cap
  writeFileSync(join(work, 'video.bin'), big);
  const r = await run(['push', '-m', 'big'], { home, cwd: work });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /video\.bin.*can't ride the folder path/, r.out);
  rmSync(base, { recursive: true, force: true });
});

test('propose carries a binary file as base64 with encoding', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'logo.png'), PNG_BYTES);
  mock.routes[`POST /api/projects/${PROJECT}/proposals`] = ({ body }) => {
    const png = body.files.find((f) => f.path === 'logo.png');
    assert.equal(png.encoding, 'base64');
    assert.deepEqual(Buffer.from(png.content, 'base64'), PNG_BYTES);
    return [201, { id: 'e2e/binary-prop' }];
  };
  const r = await run(['propose', '-m', 'binary'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /proposed 1 change/, r.out);
  rmSync(base, { recursive: true, force: true });
});

test('review renders a binary row, not a mangled line diff', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  mock.routes[`GET /api/projects/${PROJECT}/proposals`] = () => [200, { proposals: [{ id: 'e2e/binary-prop', headSha: 'ff00', author: 'e2e', createdAt: new Date().toISOString(), subject: 'binary' }] }];
  mock.routes[`GET /api/projects/${PROJECT}/proposals/diff`] = () => [200, {
    base: 'aaaa1111', head: 'ff00',
    files: [{ path: 'logo.png', status: 'added', before: null, after: null, binary: true, bytes: 24 }],
  }];
  const r = await run(['review', 'binary-prop'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /logo\.png\s+binary file \(24 bytes\)/, r.out);
  rmSync(base, { recursive: true, force: true });
});


// the server force-merges `.env`, `.env.*` and `*.log` into every repo's .gitignore
// (REQUIRED_IGNORES, space-git.ts) and never removes them, so such a file can be WRITTEN to the
// server but never COMMITTED: invisible to every pull/clone, unrecoverable through any git-backed
// surface — while still sitting in the build's cwd, where Vite reads it and inlines VITE_* into the
// PUBLIC bundle (verified empirically: a .env holding sk_live_… landed verbatim in dist/assets).
// So the CLI withholds them, and — like the platform-managed partition above — must SAY so.
test('push withholds .env / *.log instead of uploading a file no clone can ever see', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');
  writeFileSync(join(work, '.env'), 'VITE_STRIPE_SECRET=sk_live_should_never_leave\n');
  writeFileSync(join(work, '.env.production'), 'VITE_X=1\n');
  writeFileSync(join(work, 'debug.log'), 'noise\n');
  mock.routes[`POST /api/projects/${PROJECT}/write-set`] = ({ body }) => {
    const paths = body.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['index.html'], 'only the real change may reach the wire');
    return [200, { commit: 'bbbb2222' }];
  };
  const r = await run(['push', '-m', 'edit'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /never store/, 'must announce the withheld files');
  assert.match(r.out, /\.env/, 'must name them');
  assert.match(r.out, /pushed 1 write\(s\)/);
  rmSync(base, { recursive: true, force: true });
});

// ── the create/init split ────────────────────────────────────────
// `init` means "adopt this folder" and `create`
// took over the old job. The old forms must HARD-ERROR for one minor version rather than be
// reinterpreted: `trivial init my-app` under the new meaning would adopt the CURRENT folder into a
// project named "my-app" — a project built from the wrong tree, silently.
test('the old create-form `trivial init <name>` hard-errors instead of being reinterpreted', async () => {
  const { home, work, base } = freshDirs();
  writeFileSync(join(work, 'package.json'), '{"name":"mine"}');
  const r = await run(['init', 'my-app'], { home, cwd: work });
  assert.notEqual(r.code, 0, 'must refuse, not proceed');
  assert.match(r.out, /no longer creates a project/, 'must say the verb changed meaning');
  assert.match(r.out, /trivial create my-app/, 'must name the exact replacement command');
  rmSync(base, { recursive: true, force: true });
});

test('the old create-form `trivial init --here` hard-errors and names `create --here`', async () => {
  const { home, work, base } = freshDirs();
  const r = await run(['init', '--here'], { home, cwd: work });
  assert.notEqual(r.code, 0, 'must refuse, not proceed');
  assert.match(r.out, /trivial create --here/, 'must name the exact replacement command');
  rmSync(base, { recursive: true, force: true });
});

test('`create` is a real verb and `help` teaches both halves of the split', async () => {
  const { home, work, base } = freshDirs();
  const help = await run(['help'], { home, cwd: work });
  assert.match(help.out, /create <name> \| --here/, 'help must document create');
  assert.match(help.out, /init .*adopt THIS folder/, 'help must document init as adoption');
  // Wired to a real handler: with no credential it must fail on AUTH, not on "unknown command".
  const r = await run(['create', 'thing'], { home, cwd: work });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not logged in/, `create must reach the auth check, got: ${r.out}`);
  rmSync(base, { recursive: true, force: true });
});

// ── `trivial init` — adopt this folder ───────────────────────────
// Adoption rides GIT, not the write-set: the write-set's MAX_FILES=1000 and ~7 MB body ceiling are
// transport properties, and a real repo is exactly what exceeds them. These tests drive the real
// verb against a real local git remote configured the way the server configures project repos.

/** A project repo shaped like `createSite` + `ensureRepo` leave one: on `master` (bare `git init`,
 *  `init.defaultBranch` unset on the server), a one-file `.gitignore` baseline commit, and the
 *  push-to-checkout + updateInstead pair that reconciles a push into the checked-out tree. */
function serverRepo(base, owner, slug, files = {}) {
  const hooks = join(base, 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'push-to-checkout'), '#!/bin/sh\ngit read-tree -u -m HEAD "$1"\n', { mode: 0o755 });
  const dir = join(base, 'gitremote', owner, slug);
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.env\n.trivial/\n*.log\n');
  // `files` is for the CLONE direction (a project that already has a tree); the adopt tests pass
  // none and get the bare baseline they push into.
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');                       // NO -b: exactly what initInline does → master
  g('add', '-A');
  g('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'baseline: scaffold');
  g('config', 'core.hooksPath', hooks);
  g('config', 'receive.denyCurrentBranch', 'updateInstead');
  return dir;
}

/** The `file://` base a `--git-url` points at, and the HEAD a clone of it should land on. */
function serverGitUrl(base) { return `file://${join(base, 'gitremote')}`; }
function repoHead(dir) { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim(); }

/** A developer's repo: unrelated history, on `main` like every modern default. */
function devRepo(dir) {
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"my-app","scripts":{"build":"vite build"}}');
  writeFileSync(join(dir, 'src', 'App.jsx'), 'export default () => <h1>hi</h1>\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.name=D', '-c', 'user.email=d@d', 'commit', '-q', '-m', 'my app');
  return dir;
}

function adoptRoutes(slug = 'my-app') {
  mock.routes['POST /api/sites'] = ({ body }) => {
    assert.equal(body.scaffold, 'none', 'adoption must create with an EMPTY source — never a scaffold to overwrite');
    return [201, { site: { id: 'site-1', project_id: PROJECT, project_slug: 'untitled-7', handle: 'h' } }];
  };
  mock.routes[`PATCH /api/projects/${PROJECT}`] = ({ body }) => [200, { project: { slug: body.slug } }];
  mock.routes['GET /api/cli/whoami'] = () => [200, { user: { id: 'u1', username: 'dev', name: 'Dev' } }];
  return slug;
}

test('init adopts the folder: creates EMPTY, pushes the real tree, lands it in the source dir', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  const app = join(work, 'my-app');
  mkdirSync(app); devRepo(app);
  const remote = serverRepo(base, 'dev', 'my-app');
  adoptRoutes();

  const r = await run(['init', '--api', API, '--git-url', join(base, 'gitremote'), '--yes'], { home, cwd: app });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /adopted → dev\/my-app/);

  // The push must have reconciled into the CHECKED-OUT branch, not created a second one.
  const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: remote }).toString().trim().split('\n');
  assert.deepEqual(branches, ['master'], `a stray branch means the push silently no-oped: ${branches}`);
  assert.ok(existsSync(join(remote, 'package.json')), 'the app must be IN the source dir, not just in refs');
  assert.ok(existsSync(join(remote, 'src', 'App.jsx')));
  rmSync(base, { recursive: true, force: true });
});

test('init leaves the developer\'s own remote alone and adds trivial alongside it', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  const app = join(work, 'my-app');
  mkdirSync(app); devRepo(app);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/dev/my-app.git'], { cwd: app });
  serverRepo(base, 'dev', 'my-app');
  adoptRoutes();

  const r = await run(['init', '--api', API, '--git-url', join(base, 'gitremote'), '--yes'], { home, cwd: app });
  assert.equal(r.code, 0, r.out);
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: app }).toString().trim();
  assert.equal(origin, 'https://github.com/dev/my-app.git', 'their GitHub remote must be untouched');
  assert.match(execFileSync('git', ['remote'], { cwd: app }).toString(), /trivial/);
  // The token must never be written into .git/config — that is what the credential helper is for.
  const cfg = readFileSync(join(app, '.git', 'config'), 'utf8');
  assert.ok(!cfg.includes('trv_'), 'a token in .git/config leaks through `git remote -v` and screenshots');
  assert.match(cfg, /trivial git-credential/, 'the credential helper must be wired for this repo');
  rmSync(base, { recursive: true, force: true });
});

test('init writes a baseline that does not read as a mass delete on the next push', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  const app = join(work, 'my-app');
  mkdirSync(app); devRepo(app);
  // A file git tracks but hashTree deliberately skips (its IGNORE set covers build/). If the
  // baseline were built from the tracked list alone, this path would have no local counterpart
  // and the very next `trivial push` would try to DELETE it.
  mkdirSync(join(app, 'build'), { recursive: true });
  writeFileSync(join(app, 'build', 'keep.txt'), 'tracked but invisible to hashTree\n');
  execFileSync('git', ['add', '-f', 'build/keep.txt'], { cwd: app });
  execFileSync('git', ['-c', 'user.name=D', '-c', 'user.email=d@d', 'commit', '-q', '-m', 'track a build file'], { cwd: app });
  serverRepo(base, 'dev', 'my-app');
  adoptRoutes();

  const r = await run(['init', '--api', API, '--git-url', join(base, 'gitremote'), '--yes'], { home, cwd: app });
  assert.equal(r.code, 0, r.out);
  const state = readState(app);
  assert.ok(!('build/keep.txt' in state.files), 'a hashTree-invisible path must stay OUT of the baseline');
  assert.ok('package.json' in state.files, 'real files must be in it');

  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, { head: state.baseSha, files: [] }];
  const st = await run(['status'], { home, cwd: app });
  assert.match(st.out, /local\s+0 changed, 0 deleted/, `a fresh adoption must be clean, not pending a mass delete:\n${st.out}`);
  rmSync(base, { recursive: true, force: true });
});

test('init refuses the cases it cannot honestly serve, and creates nothing when it does', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  adoptRoutes();
  const at = (dir) => run(['init', '--api', API, '--git-url', join(base, 'gitremote'), '--yes'], { home, cwd: dir });

  const plain = join(work, 'plain'); mkdirSync(plain);
  writeFileSync(join(plain, 'index.html'), '<h1>hi</h1>');
  const noRepo = await at(plain);
  assert.notEqual(noRepo.code, 0);
  assert.match(noRepo.out, /not a git repository/);
  assert.match(noRepo.out, /git init/, 'must say exactly how to fix it');

  const empty = join(work, 'empty-repo'); mkdirSync(empty);
  execFileSync('git', ['init', '-q'], { cwd: empty });
  const noCommits = await at(empty);
  assert.notEqual(noCommits.code, 0);
  assert.match(noCommits.out, /no commits yet/);

  const app = join(work, 'sub'); mkdirSync(app); devRepo(app);
  const subdir = join(app, 'src');
  const fromSub = await at(subdir);
  assert.notEqual(fromSub.code, 0);
  assert.match(fromSub.out, /subdirectory of the repo/, 'git pushes the whole tree — adopting from src/ would send everything');

  assert.equal(mock.requests.filter((q) => q.path === '/api/sites').length, 0,
    'a refusal must not have created a project first');
  rmSync(base, { recursive: true, force: true });
});

// ──  — the change feed's control flags, finally read ───────────────────
// `ChangesResponse` declared `rebuilt` and `truncated` for four releases and `pullRemote` consulted
// neither. Each test below pins one silent-data-loss path that the omission opened.

const CHANGES = `GET /api/projects/${PROJECT}/changes`;

test('convergence is not a conflict — the git/CLI phantom that wedged `sync`', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  // The exact shape after `git push trivial`: the cloud now holds what the folder holds, but
  // state.files still describes the pre-push baseline. Both sides "changed" — to the SAME bytes.
  const pushed = '<h1>pushed over git</h1>';
  writeFileSync(join(work, 'index.html'), pushed);
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [{ path: 'index.html', status: 'modified', content: pushed }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, `a file that agrees with the cloud is not a conflict:\n${r.out}`);
  assert.doesNotMatch(r.out, /changed on both sides/);
  assert.equal(readState(work).baseSha, 'bbbb2222', 'and the sync point must advance');
  rmSync(base, { recursive: true, force: true });
});

test('a REAL divergence is still a conflict (convergence did not blunt the check)', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'index.html'), '<h1>mine</h1>');
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [{ path: 'index.html', status: 'modified', content: '<h1>theirs</h1>' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /changed on both sides/);
  assert.equal(readFileSync(join(work, 'index.html'), 'utf8'), '<h1>mine</h1>', 'and must not clobber');
  rmSync(base, { recursive: true, force: true });
});

test('a truncated feed is REFUSED whole — never a partial tree under a success line', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: true, truncated: true,
    files: [{ path: 'a.txt', status: 'added', content: 'partial' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.notEqual(r.code, 0, 'truncation must not exit 0');
  assert.doesNotMatch(r.out, /✓ pulled/, 'and must never print a success line');
  assert.ok(!existsSync(join(work, 'a.txt')), 'the folder must be untouched — this is a refusal, not a partial sync');
  assert.equal(readState(work).baseSha, 'aaaa1111', 'and the sync point must NOT advance, or the rest is unreachable forever');
  assert.match(r.out, /git clone/, 'must name a transport with no cap');
  rmSync(base, { recursive: true, force: true });
});

test('a truncated CLONE fails instead of reporting files it did not get', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  mock.routes['GET /api/cli/project'] = () => [200, { id: PROJECT, owner: 'me', slug: 'app', name: 'App', role: 'owner' }];
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: true, truncated: true,
    files: [{ path: 'a.txt', status: 'added', content: 'partial' }],
  }];
  const r = await run(['clone', 'me/app', '--api', API], { home, cwd: work });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /more changed files than one sync can carry/,
    'must fail ON THE TRUNCATION — not on some earlier error that happens to be non-zero');
  assert.doesNotMatch(r.out, /✓ cloned/);
  assert.doesNotMatch(r.out, /no synced history yet/, 'the  empty-clone text is the wrong diagnosis here');
  assert.ok(!existsSync(join(work, 'app')), 'an abandoned clone leaves no half-initialised folder');
  rmSync(base, { recursive: true, force: true });
});

test('a null head does not wipe a healthy folder\'s sync point', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  // What the server returns on ANY git failure, including its 20s timeout — indistinguishable in
  // shape from an empty snapshot. Treating it as an answer would null baseSha and promote every later pull to a
  // full re-sync.
  mock.routes[CHANGES] = () => [200, { head: null, rebuilt: false, truncated: false, files: [] }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.equal(readState(work).baseSha, 'aaaa1111', 'a failed lookup must not rewrite the baseline');
  rmSync(base, { recursive: true, force: true });
});

test('a content-less entry is reported, not silently skipped', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  // The server swallows an unreadable blob (a submodule gitlink, an unrepresentable path) and emits
  // the entry with no `content`. Skipping it quietly is how a wrong tree passes for a right one.
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [{ path: 'sub', status: 'added' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /sub/, 'must name the path');
  assert.equal(readState(work).baseSha, 'aaaa1111', 'and must not advance past what it could not apply');
  rmSync(base, { recursive: true, force: true });
});

test('a rename deletes the vacated path — the old file does not survive forever', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'old.ts'), 'export const a = 1;\n');
  const st = readState(work);
  st.files['src/old.ts'] = createHash('sha256').update('export const a = 1;\n').digest('hex');
  writeState(work, st);
  // What `git diff --name-status -M` produces for a rename: R100 old new.
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [{ path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts', content: 'export const a = 1;\n' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(work, 'src', 'new.ts')), 'the new path must land');
  assert.ok(!existsSync(join(work, 'src', 'old.ts')), 'the vacated path must be REMOVED, not left as a ghost');
  assert.ok(!('src/old.ts' in readState(work).files), 'and must leave the baseline, or status lies forever');
  rmSync(base, { recursive: true, force: true });
});

test('a directory→file rename does not wedge the folder on EISDIR', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  mkdirSync(join(work, 'src', 'config'), { recursive: true });
  writeFileSync(join(work, 'src', 'config', 'index.ts'), 'export default {};\n');
  const st = readState(work);
  st.files['src/config/index.ts'] = createHash('sha256').update('export default {};\n').digest('hex');
  writeState(work, st);
  // The cloud collapsed the directory into a file AT THE DIRECTORY'S PATH. Removing the file alone
  // leaves an empty `src/config` directory, and the write then fails EISDIR — permanently, once
  // per-file failures stop advancing baseSha.
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [{ path: 'src/config', status: 'renamed', oldPath: 'src/config/index.ts', content: 'export default {};\n' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, `the emptied directory must be pruned so the file can take its place:\n${r.out}`);
  assert.ok(existsSync(join(work, 'src', 'config')), 'the path must exist');
  assert.equal(readFileSync(join(work, 'src', 'config'), 'utf8'), 'export default {};\n', 'as a FILE now');
  rmSync(base, { recursive: true, force: true });
});

test('a rename does not remove a path the same payload re-creates', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'a.txt'), 'A\n');
  const st = readState(work);
  st.files['a.txt'] = createHash('sha256').update('A\n').digest('hex');
  writeState(work, st);
  // A swap: a.txt -> b.txt, and a.txt is written afresh in the same payload. Removing the vacated
  // path blindly (after the writes, or without checking) would delete the new a.txt.
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [
      { path: 'b.txt', status: 'renamed', oldPath: 'a.txt', content: 'A\n' },
      { path: 'a.txt', status: 'added', content: 'fresh A\n' },
    ],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(work, 'b.txt'), 'utf8'), 'A\n');
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'fresh A\n', 'the re-created path must survive the rename removal');
  rmSync(base, { recursive: true, force: true });
});

test('a local edit to a renamed-away file is a conflict, not a silent resurrection', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'old.txt'), 'original\n');
  const st = readState(work);
  st.files['old.txt'] = createHash('sha256').update('original\n').digest('hex');
  writeState(work, st);
  writeFileSync(join(work, 'old.txt'), 'my local edit\n');   // edited AFTER the baseline
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [{ path: 'new.txt', status: 'renamed', oldPath: 'old.txt', content: 'original\n' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.notEqual(r.code, 0, 'editing the file the cloud renamed away is a real divergence');
  assert.match(r.out, /old\.txt/, 'and the vacated path must be named as the conflict');
  assert.equal(readFileSync(join(work, 'old.txt'), 'utf8'), 'my local edit\n', 'nothing clobbered');
  rmSync(base, { recursive: true, force: true });
});

// ──  part 3 — the rebuilt prune, and the files it must NEVER touch ─────
// This is the only code in the pull path that deletes. The candidate set is `state.cloud` — paths
// we watched ARRIVE from the cloud — precisely because absence from a full-tree payload does not
// mean "deleted": it also means "accepted but never committed", which is a real class (the server
// checkpoints with `git add -A`, honouring the project's .gitignore).

const REBUILT = (files, head = 'bbbb2222') => () => [200, { head, rebuilt: true, truncated: false, files }];

test('rebuilt: a file the cloud deleted is removed locally instead of living forever', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'gone.txt'), 'delete me on the server\n');
  const st = readState(work);
  st.files['gone.txt'] = createHash('sha256').update('delete me on the server\n').digest('hex');
  st.cloud = ['index.html', 'gone.txt'];          // provenance: both arrived from the cloud
  writeState(work, st);
  mock.routes[CHANGES] = REBUILT([{ path: 'index.html', status: 'added', content: '<h1>hi</h1>' }]);
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(work, 'gone.txt')), 'a cloud-origin file absent from the full tree was deleted');
  assert.ok(!('gone.txt' in readState(work).files));
  assert.deepEqual(readState(work).cloud, ['index.html'], 'provenance follows the tree');
  rmSync(base, { recursive: true, force: true });
});

test('rebuilt: a file that was ACCEPTED but never committed is NOT deleted', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  // Verified against prod: a write-set POST of `.trivial-deps/probe.txt` returns 200, lands on
  // disk, and never enters git HEAD — the server's checkpoint is `git add -A` and REQUIRED_IGNORES
  // covers it. It passes isPlatformManaged, isNeverUploadable AND hashTree's IGNORE, so every
  // filter-based prune would delete it. Only provenance saves it.
  writeFileSync(join(work, 'keep.txt'), 'pushed, accepted, never committed\n');
  const st = readState(work);
  st.files['keep.txt'] = createHash('sha256').update('pushed, accepted, never committed\n').digest('hex');
  st.cloud = ['index.html'];                       // it never ARRIVED from the cloud
  writeState(work, st);
  mock.routes[CHANGES] = REBUILT([{ path: 'index.html', status: 'added', content: '<h1>hi</h1>' }]);
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(work, 'keep.txt')), 'absence from the tree is NOT evidence the cloud deleted it');
  rmSync(base, { recursive: true, force: true });
});

test('rebuilt: a folder with no provenance yet prunes NOTHING, and gains provenance', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);                       // clonedFixture writes no `cloud` key
  writeFileSync(join(work, 'mystery.txt'), 'origin unknown\n');
  const st = readState(work);
  st.files['mystery.txt'] = createHash('sha256').update('origin unknown\n').digest('hex');
  writeState(work, st);
  assert.equal(readState(work).cloud, undefined, 'precondition: a ≤0.14.0 folder');
  mock.routes[CHANGES] = REBUILT([{ path: 'index.html', status: 'added', content: '<h1>hi</h1>' }]);
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(work, 'mystery.txt')), 'without provenance the prune must not guess');
  assert.deepEqual(readState(work).cloud, ['index.html'], 'and it self-heals for next time');
  rmSync(base, { recursive: true, force: true });
});

test('rebuilt: a locally-edited file the cloud dropped is a CONFLICT, not a silent delete', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeFileSync(join(work, 'mine.txt'), 'the cloud version\n');
  const st = readState(work);
  st.files['mine.txt'] = createHash('sha256').update('the cloud version\n').digest('hex');
  st.cloud = ['index.html', 'mine.txt'];
  writeState(work, st);
  writeFileSync(join(work, 'mine.txt'), 'my unsaved work\n');   // edited since
  mock.routes[CHANGES] = REBUILT([{ path: 'index.html', status: 'added', content: '<h1>hi</h1>' }]);
  const r = await run(['pull'], { home, cwd: work });
  assert.notEqual(r.code, 0, 'deleting edited work needs an explicit decision');
  assert.match(r.out, /mine\.txt/);
  assert.equal(readFileSync(join(work, 'mine.txt'), 'utf8'), 'my unsaved work\n', 'untouched');
  assert.match(r.out, /--force/, 'and --force must warn that it deletes, not just overwrites');
  rmSync(base, { recursive: true, force: true });
});

test('a committed build/ path is written but never baselined — and a legacy one is repaired', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  // A folder poisoned by ≤0.14.0: hashTree cannot see `build/`, so this baseline entry made
  // diffLocal emit a DELETE on every push, which the write path refuses as a system path.
  const st = readState(work);
  st.files['build/legacy.js'] = 'deadbeef';
  writeState(work, st);
  mock.routes[CHANGES] = () => [200, {
    head: 'bbbb2222', rebuilt: false, truncated: false,
    files: [{ path: 'build/out.js', status: 'added', content: 'console.log(1)\n' }],
  }];
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(work, 'build', 'out.js')), 'the file is still WRITTEN — the cloud has it');
  const after = readState(work);
  assert.ok(!('build/out.js' in after.files), 'but never baselined');
  assert.ok(!('build/legacy.js' in after.files), 'and the legacy entry is repaired, unwedging push');
  rmSync(base, { recursive: true, force: true });
});

test('init on a dirty tree leaves the uncommitted work pushable, not silently stranded', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  const app = join(work, 'my-app');
  mkdirSync(app); devRepo(app);
  serverRepo(base, 'dev', 'my-app');
  adoptRoutes();
  // Adoption pushes HEAD, so the cloud gets the COMMITTED bytes. If the baseline recorded the
  // working-tree hash instead, `status` would report clean and this edit would never reach Trivial.
  writeFileSync(join(app, 'package.json'), '{"name":"my-app","dirty":true}');

  const r = await run(['init', '--api', API, '--git-url', join(base, 'gitremote'), '--yes'], { home, cwd: app });
  assert.equal(r.code, 0, r.out);
  const state = readState(app);
  assert.ok(!('package.json' in state.files), 'a dirty path must stay OUT of the baseline');
  assert.ok('src/App.jsx' in state.files, 'clean tracked paths still baseline normally');
  assert.deepEqual(state.cloud.includes('package.json'), true, 'the cloud does hold the committed version');

  // The proof: the uncommitted edit is now an ordinary pending change.
  mock.routes[`GET /api/projects/${PROJECT}/changes`] = () => [200, { head: state.baseSha, rebuilt: false, truncated: false, files: [] }];
  const st = await run(['status'], { home, cwd: app });
  assert.match(st.out, /1 changed/, `the dirty file must show as pending, got:\n${st.out}`);
  rmSync(base, { recursive: true, force: true });
});

// ──  — paging the change feed ──────────────────────────────────────────
// The server caps a response by BYTES, so a large change set arrives across pages. Nothing may be
// applied until every page has landed: the conflict check needs the whole incoming set, and the
// rebuilt prune needs the union of paths to know what is genuinely absent.

test('a paged feed is assembled across pages before anything is applied', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  const pages = {
    '': { cursor: 'a.txt', truncated: true, files: [{ path: 'a.txt', status: 'added', content: 'A' }] },
    'a.txt': { cursor: 'b.txt', truncated: true, files: [{ path: 'b.txt', status: 'added', content: 'B' }] },
    'b.txt': { cursor: null, truncated: false, files: [{ path: 'c.txt', status: 'added', content: 'C' }] },
  };
  mock.routes['GET /api/cli/project'] = () => [200, { id: PROJECT, owner: 'me', slug: 'app', name: 'App', role: 'owner' }];
  mock.routes[CHANGES] = ({ query }) => {
    const p = pages[query.after ?? ''];
    return [200, { head: 'bbbb2222', rebuilt: true, truncated: p.truncated, ...(p.cursor ? { cursor: p.cursor } : {}), total: 3, files: p.files }];
  };
  const r = await run(['clone', 'me/app', '--api', API], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  for (const [f, want] of [['a.txt', 'A'], ['b.txt', 'B'], ['c.txt', 'C']]) {
    assert.equal(readFileSync(join(work, 'app', f), 'utf8'), want, `${f} must land`);
  }
  assert.deepEqual(readState(join(work, 'app')).cloud, ['a.txt', 'b.txt', 'c.txt'],
    'provenance must be the UNION of pages, or the next prune deletes what page 2 delivered');
  rmSync(base, { recursive: true, force: true });
});

test('a HEAD that moves mid-walk restarts instead of assembling a tree that never existed', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  let call = 0;
  mock.routes[CHANGES] = ({ query }) => {
    call += 1;
    // calls 1-2: head A, then HEAD moves. calls 3+: head B, consistent, two pages.
    if (call === 1) return [200, { head: 'AAAA', rebuilt: true, truncated: true, cursor: 'a.txt', files: [{ path: 'a.txt', status: 'added', content: 'A' }] }];
    if (call === 2) return [200, { head: 'BBBB', rebuilt: true, truncated: true, cursor: 'b.txt', files: [{ path: 'b.txt', status: 'added', content: 'stale' }] }];
    if (query.after === 'a.txt') return [200, { head: 'BBBB', rebuilt: true, truncated: false, files: [{ path: 'b.txt', status: 'added', content: 'B' }] }];
    return [200, { head: 'BBBB', rebuilt: true, truncated: true, cursor: 'a.txt', files: [{ path: 'a.txt', status: 'added', content: 'A' }] }];
  };
  const r = await run(['pull'], { home, cwd: work });
  assert.equal(r.code, 0, r.out);
  assert.equal(readState(work).baseSha, 'BBBB', 'the completed walk is the one that counts');
  assert.equal(readFileSync(join(work, 'b.txt'), 'utf8'), 'B', 'and it must carry the RESTARTED page, not the abandoned one');
  rmSync(base, { recursive: true, force: true });
});

test('a project that never stops moving refuses instead of looping forever', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  let head = 0;
  // A fresh HEAD on every single request — the walk can never complete.
  mock.routes[CHANGES] = () => {
    head += 1;
    return [200, { head: `H${head}`, rebuilt: true, truncated: true, cursor: 'a.txt', files: [{ path: 'a.txt', status: 'added', content: 'A' }] }];
  };
  const r = await run(['pull'], { home, cwd: work });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /kept changing/, 'must say WHY it gave up');
  assert.equal(readState(work).baseSha, 'aaaa1111', 'and must not advance');
  rmSync(base, { recursive: true, force: true });
});

test('an API with no cursor still gets the old refusal (safe degradation)', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  // An older server: `truncated` with no `cursor`. There is nothing to page with, so the
  // only honest answer is still to refuse the whole pull.
  mock.routes[CHANGES] = () => [200, { head: 'bbbb2222', rebuilt: true, truncated: true, files: [{ path: 'a.txt', status: 'added', content: 'A' }] }];
  const r = await run(['pull'], { home, cwd: work });
  assert.notEqual(r.code, 0);
  assert.ok(!existsSync(join(work, 'a.txt')), 'nothing applied');
  rmSync(base, { recursive: true, force: true });
});

test('a folder holding only .git is called a repository, not "a codebase"', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  const bare = join(work, 'bare');
  mkdirSync(bare);
  execFileSync('git', ['init', '-q'], { cwd: bare, stdio: 'pipe' });
  const r = await run(['create', '--here', '--api', API], { home, cwd: bare });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /already has a git repository/, 'a bare .git is not a codebase — saying so is a small lie at the first thing a developer sees');
  assert.doesNotMatch(r.out, /contains a codebase/);
  assert.match(r.out, /trivial init/, 'and it must still hand over');

  // …while a real tree still reads as one.
  const app = join(work, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: app, stdio: 'pipe' });
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(join(app, 'src', 'a.ts'), 'x');
  const r2 = await run(['create', '--here', '--api', API], { home, cwd: app });
  assert.match(r2.out, /contains a codebase/);
  rmSync(base, { recursive: true, force: true });
});

// ── the situation screen (bare `trivial`) ───────────────────────────────────
// Four states, one screen. The contract that matters most is the last assertion in each: the
// greeting makes NO network call, because it is what a new install runs and what someone types
// when they have lost the thread — it has to answer instantly, and it has to answer offline.

test('bare `trivial` on a fresh machine greets, and asks for exactly one thing', async () => {
  const { home, work, base } = freshDirs();
  const r = await run([], { home, cwd: work });
  assert.equal(r.code, 0, 'a bare invocation is not an error');
  assert.match(r.out, /^\s*trivial \d+\.\d+\.\d+$/m, 'the name is printed as the name');
  assert.match(r.out, /Your Trivial projects, on your machine/, 'the first run says what this is');
  assert.match(r.out, /next:\n\s+trivial login/, 'and exactly one next step');
  assert.match(r.out, /npm audit signatures/, 'the provenance line belongs to the first run');
  // The failure this screen replaced: 45 lines of reference, with `login` scrolled off the top.
  assert.doesNotMatch(r.out, /credential\.https/, 'the git helper block is not first-contact material');
  assert.ok(r.out.split('\n').length < 20, `the greeting must fit a terminal, got ${r.out.split('\n').length} lines`);
  assert.equal(mock.requests.length, 0, 'the greeting must not touch the network');
  rmSync(base, { recursive: true, force: true });
});

test('bare `trivial` on a known machine that is signed out drops the ceremony', async () => {
  const { home, work, base } = freshDirs();
  mkdirSync(join(home, '.trivial'), { recursive: true });   // been here before, no credential
  const r = await run([], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /isn't signed in/);
  assert.match(r.out, /trivial login/);
  assert.doesNotMatch(r.out, /Your Trivial projects, on your machine/, 'the tagline is a first-run thing only');
  assert.doesNotMatch(r.out, /npm audit signatures/);
  rmSync(base, { recursive: true, force: true });
});

test('bare `trivial` signed in but outside a project offers the three ways in', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  writeFileSync(join(home, '.trivial', 'profile.json'), JSON.stringify({ [API]: { username: 'ryan' } }));
  const r = await run(['--api', API], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /signed in as ryan/, 'the cached name, without asking the server');
  assert.match(r.out, /not in a project folder/);
  for (const verb of ['trivial create', 'trivial clone', 'trivial init']) {
    assert.match(r.out, new RegExp(verb), `must offer ${verb}`);
  }
  assert.equal(mock.requests.length, 0, 'still no network');
  rmSync(base, { recursive: true, force: true });
});

test('bare `trivial` inside a project reads the folder and points at the unsent work', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  writeState(work, { ...readState(work), ref: 'ryan/field-notes' });
  writeFileSync(join(work, 'index.html'), '<h1>edited</h1>');   // one local change
  const r = await run([], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /ryan\/field-notes/, 'the header names the project');
  assert.match(r.out, /1 changed, 0 deleted/, 'the local diff is local — no server involved');
  assert.match(r.out, /next:\n\s+trivial push/, 'unsent work is the recommended verb');
  assert.equal(mock.requests.length, 0, 'the diff is computed from the folder, not fetched');
  rmSync(base, { recursive: true, force: true });
});

test('a clean folder moves the recommendation from push to dev', async () => {
  const { home, work, base } = freshDirs();
  clonedFixture(home, work);
  const r = await run([], { home, cwd: work });
  assert.match(r.out, /no local changes/);
  assert.match(r.out, /next:\n\s+trivial dev/, 'nothing to send — go build something');
  rmSync(base, { recursive: true, force: true });
});

// ── `trivial help` — the reference, and only when asked ─────────────────────

test('help is grouped, and the reference-grade material moved to topics', async () => {
  const { home, work, base } = freshDirs();
  const r = await run(['help'], { home, cwd: work });
  assert.equal(r.code, 0);
  for (const group of ['start', 'the loop', 'ship', 'review', 'this machine']) {
    assert.match(r.out, new RegExp(`\\n  ${group}\\b`), `help must group under "${group}"`);
  }
  // These used to be on the screen a first-time user saw. They are now one command away.
  assert.doesNotMatch(r.out, /credential\.https/, 'the git helper block belongs to `help git`');
  assert.doesNotMatch(r.out, /trv_\.\.\./, 'the token form belongs to `help agents`');

  const git = await run(['help', 'git'], { home, cwd: work });
  assert.match(git.out, /credential\.https:\/\/git\.trivial\.so\.helper/);
  const agents = await run(['help', 'agents'], { home, cwd: work });
  assert.match(agents.out, /--token trv_\.\.\./);
  const install = await run(['help', 'install'], { home, cwd: work });
  assert.match(install.out, /npm i -g @trivial-so\/cli/);
  assert.match(install.out, /npm audit signatures/);

  const missing = await run(['help', 'nope'], { home, cwd: work });
  assert.match(missing.out, /no help topic "nope"/);
  assert.match(missing.out, /git\s+agents\s+install/, 'and it names the ones that exist');
  rmSync(base, { recursive: true, force: true });
});

test('an unknown command gets one line and a suggestion, not the manual', async () => {
  const { home, work, base } = freshDirs();
  const typo = await run(['puhs'], { home, cwd: work });
  assert.equal(typo.code, 1);
  assert.match(typo.out, /unknown command 'puhs'\. Did you mean `push`\?/, 'a transposition is the commonest typo');
  assert.ok(typo.out.split('\n').length <= 3, `a typo is worth 2 lines, got: ${typo.out}`);

  const abbrev = await run(['stat'], { home, cwd: work });
  assert.match(abbrev.out, /Did you mean `status`\?/, 'an abbreviation is not a typo');

  const nonsense = await run(['frobnicate'], { home, cwd: work });
  assert.equal(nonsense.code, 1);
  assert.doesNotMatch(nonsense.out, /Did you mean/, 'no suggestion is better than a wrong one');
  rmSync(base, { recursive: true, force: true });
});

test('a folder cloned with git is recognised as one, not called "not a project"', async () => {
  const { home, work, base } = freshDirs();
  writeCreds(home, { [API]: 'trv_user' });
  execFileSync('git', ['init', '-q', '.'], { cwd: work });
  execFileSync('git', ['remote', 'add', 'trivial', 'https://git.trivial.so/ryan/field-notes'], { cwd: work });
  const r = await run(['--api', API], { home, cwd: work });
  assert.equal(r.code, 0);
  assert.match(r.out, /ryan\/field-notes \(git checkout\)/, 'the remote names the project');
  assert.match(r.out, /no sync state/, 'and says why the sync verbs will not work');
  assert.match(r.out, /next:\n\s+trivial dev/, '`dev` is the one CLI verb that needs no state');
  assert.doesNotMatch(r.out, /not in a project folder/, 'they are plainly standing in one');
  assert.equal(mock.requests.length, 0);
  rmSync(base, { recursive: true, force: true });
});
