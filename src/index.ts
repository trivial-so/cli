// trivial — the folder-path client. Option B: pull = the change feed,
// push = a content diff through the validated write API. Zero runtime deps (Node 24 builtins).
import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  getChanges, pushWriteSet, createProposal, HttpError,
  startDeviceLogin, pollDeviceLogin, whoami, serverLogout, listProjects, resolveProject,
  publishSite, buildPreview, publishPreflight, createProject, renameProject,
  listProposals, proposalDiff, acceptProposal, rejectProposal, type Proposal,
  type WriteSetFile, type ChangeFile, type ChangesResponse,
} from './api.js';
import {
  readState, writeState, getToken, setToken,
  getUserToken, setUserToken, deleteUserToken,
  credsDirPath, listCredentials, removeCredentialsDir, type State,
} from './config.js';
import { hashTree, diffLocal, writeLocalFile, deleteLocalFile, readLocalBytes, decodeWireContent, isBinaryBuffer, sha256, isIgnoredPath } from './sync.js';
import {
  git, gitAvailable, isRepo, repoRoot, headSha, isDirty, trackedFiles,
  packedSizeKb, remoteUrl, remoteHeadBranch, modifiedAgainstHead, cloneRepo,
} from './git.js';
import { diffLines, countChanges, renderDiff } from './diff.js';

const DEFAULT_API = 'https://api.trivial.so';

// Stamped by esbuild --define from package.json's version (see the build script);
// 'dev' only when run un-bundled. The version discipline: any behavior change
// bumps package.json + cli/CHANGELOG.md in the same commit.
declare const CLI_VERSION: string;
const VERSION = typeof CLI_VERSION !== 'undefined' ? CLI_VERSION : 'dev';

function die(msg: string): never { console.error(`✗ ${msg}`); process.exit(1); }
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : '(none)');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Args { cmd: string; positional: string[]; flags: Record<string, string | boolean>; }
function parseArgs(argv: string[]): Args {
  const [cmd, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-m') { flags.message = rest[++i] ?? ''; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { cmd: cmd || 'help', positional, flags };
}

async function loadContext(folder: string): Promise<{ state: State; token: string }> {
  const state = await readState(folder);
  if (!state) die('not a Trivial folder (no .trivial/state.json). Run `trivial clone` first.');
  // getToken prefers a per-project token, then falls back to the `trivial login` credential.
  const token = await getToken(state!.apiUrl, state!.projectId);
  if (!token) die('no credential for this project — run `trivial login`.');
  return { state: state!, token: token! };
}

/**
 * `trivial dev` — run the app locally with its own data.
 *
 * Deliberately needs NO credential: everything it serves is compiled from files already in the
 * folder, against a database in this process. Requiring a token would imply it talks to us, and it
 * doesn't — a maker on a plane can still develop. It reads `.trivial/state.json` only for the
 * projectId, which the data plane's cross-project wall compares against.
 */
async function cmdDev(args: Args): Promise<void> {
  const folder = process.cwd();
  const state = await readState(folder);
  // Fall back to the build-injected config, so a `.tar.gz` download works too.
  let projectId = state?.projectId ?? '';
  if (!projectId) {
    try {
      const raw = await fsp.readFile(join(folder, 'src', 'trivial.config.json'), 'utf8');
      projectId = (JSON.parse(raw) as { projectId?: string }).projectId ?? '';
    } catch { /* neither — reported below */ }
  }
  if (!projectId) {
    die('not a Trivial project folder (no .trivial/state.json and no src/trivial.config.json).\n  Run `trivial clone <owner>/<slug>` first.');
  }

  const rawAs = args.flags.as as string | undefined;
  const identity = !rawAs || rawAs === 'anon'
    ? { userId: null, role: null }
    // `--as alice:admin` previews as a Local user carrying a declared role.
    : { userId: rawAs.split(':')[0] || null, role: rawAs.split(':')[1] ?? null };

  const { runDev } = await import('./dev.js');
  await runDev({
    folder,
    projectId,
    port: Number(args.flags.port) || 5173,
    identity,
  });
}

/** Best-effort: pop the sign-in page. Headless/SSH just uses the printed URL. */
function openBrowser(url: string): void {
  // `BROWSER=none` — the convention vite, create-react-app and python's webbrowser all honour for
  // "print it, don't launch it". This is the half that makes the test harness's env setting mean
  // anything: without it the suite sets BROWSER=none and nothing reads it, which is exactly the
  // state that kept opening tabs at the mock server on a developer's desktop (2026-08-07). TWO
  // commands reach here — `open` and `login`'s device flow — so guarding the helper rather than the
  // callers is what covers both, and whatever is added next.
  //
  // The rule underneath, worth keeping in one sentence: a test suite must not reach out of the
  // process it runs in.
  if (process.env.BROWSER === 'none') return;
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no opener — the printed URL is the path */ });
    child.unref();
  } catch { /* ignore */ }
}

// ── pull ── apply the cloud's changes-since-baseSha. Returns an outcome (no die), so both the
// one-shot command and the sync loop can decide what to do with a conflict.
type PullOutcome =
  | { kind: 'applied'; count: number; head: string | null }
  | { kind: 'conflict'; files: string[] }
  // the pull could not be completed FAITHFULLY. Distinct from a conflict (which is a
  // decision the maker can make) and from success. Never reported as a success line.
  | { kind: 'incomplete'; reason: string; details: string[] };

/**
 * Remove a path the cloud no longer has, and tidy up behind it.
 *
 * `deleteLocalFile` is `fs.rm(..., {force: true})` — no `recursive`, so it removes a file and
 * leaves an empty directory sitting where a file may be about to be written. That is exactly the
 * directory→file rename (`src/config/index.ts` → `src/config`): the removal succeeds, the write
 * then fails EISDIR, and with per-file containment the folder would refuse that pull forever.
 * So prune ancestor directories the removal just emptied, stopping the moment one is non-empty
 * (ENOTEMPTY) or gone (ENOENT). Never touches a directory that still holds anything.
 */
async function removeLocalPath(folder: string, rel: string): Promise<void> {
  await deleteLocalFile(folder, rel);
  let dir = dirname(rel);
  while (dir && dir !== '.' && dir !== '/' && dir !== '..') {
    try { await fsp.rmdir(join(folder, dir)); } catch { return; }
    dir = dirname(dir);
  }
}

/**
 * A clone that could not complete must not leave a folder behind.
 *
 * Both clone forms write `.trivial/state.json` BEFORE pulling, so a refusal used to leave a
 * half-initialised project directory — with the refusal text claiming "your folder was left
 * exactly as it was", which was then false. An inert folder carrying a projectId and no files is
 * worse than none: `trivial status` reads it as a real project with nothing in it.
 */
async function abandonClone(dir: string, out: { reason: string; details: string[] }): Promise<never> {
  await fsp.rm(join(dir, '.trivial'), { recursive: true, force: true }).catch(() => { /* best effort */ });
  await fsp.rmdir(dir).catch(() => { /* non-empty (the user's own dir) — leave it alone */ });
  return die(incompleteText(out));
}

/** Render an `incomplete` pull. There is deliberately no success-shaped variant: the whole
 *  point of the kind is that no caller can report it as one. */
function incompleteText(out: { reason: string; details: string[] }): string {
  return [out.reason, ...out.details.map((d) => `  ${d}`)].join('\n');
}

/** Bound on what one pull may accumulate in the CLI's own memory. The server pages at 8 MB,
 *  so this is purely the client's guard against assembling an unbounded tree in RAM. Well above the
 *  fleet's largest project (280 MB); anything past it is a job for `git clone`. */
const MAX_PULL_BYTES = 512 * 1024 * 1024;

async function pullRemote(folder: string, state: State, token: string, force: boolean): Promise<PullOutcome> {
  // ── PAGE THE FEED ── the server caps a response by BYTES, so a large change set arrives
  // across several pages, each carrying a `cursor` to resume from.
  //
  // The pages must describe ONE tree. `head` is echoed on every page and the diff is a pure
  // function of `since..HEAD`, so a HEAD that moves mid-walk means the basis changed underneath us
  // and the pages can no longer be concatenated — assembling them anyway would build a tree that
  // never existed. Detect it and restart; a few retries, then give up honestly rather than loop.
  //
  // Nothing is applied until every page has arrived: the conflict check needs the whole incoming
  // set, and the rebuilt prune needs the union of paths to know what is genuinely absent.
  let changes = await getChanges(state.apiUrl, state.projectId, token, state.baseSha);
  if (changes.truncated && changes.cursor) {
    const MAX_RESTARTS = 3;
    let restarts = 0;
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      const head = changes.head;
      const collected = [...changes.files];
      let bytes = collected.reduce((n, f) => n + (f.content?.length ?? 0), 0);
      let cursor: string | null = changes.cursor ?? null;
      let moved = false;
      let overflow = false;
      while (cursor) {
        const page: ChangesResponse = await getChanges(state.apiUrl, state.projectId, token, state.baseSha, cursor);
        if (page.head !== head) { moved = true; break; }
        collected.push(...page.files);
        bytes += page.files.reduce((n, f) => n + (f.content?.length ?? 0), 0);
        if (bytes > MAX_PULL_BYTES) { overflow = true; break; }
        if (!page.truncated || !page.cursor) { cursor = null; break; }
        cursor = page.cursor;
      }
      if (overflow) {
        return {
          kind: 'incomplete',
          reason: 'this project is too large to sync through the CLI in one go, so nothing was applied.',
          details: [
            'Your folder was left exactly as it was — this is a refusal, not a partial sync.',
            'Use the git remote, which streams instead of buffering:',
            '  git clone https://git.trivial.so/<owner>/<slug>',
          ],
        };
      }
      if (!moved) { changes = { ...changes, truncated: false, cursor: undefined, files: collected }; break; }
      if (++restarts > MAX_RESTARTS) {
        return {
          kind: 'incomplete',
          reason: 'the project kept changing while this sync was reading it, so nothing was applied.',
          details: [
            'Your folder was left exactly as it was — this is a refusal, not a partial sync.',
            'Someone else (or a Trio run) is editing right now. Try again in a moment.',
          ],
        };
      }
      changes = await getChanges(state.apiUrl, state.projectId, token, state.baseSha);
      if (!changes.truncated || !changes.cursor) break;
    }
  }

  // ── STILL TRUNCATED ── refuse BEFORE touching disk or state.
  //
  // Reached when the server sliced the feed but sent no `cursor` — an older API, where
  // `since` is the only parameter and re-asking returns the identical page. Applying the slice and
  // advancing baseSha (as this function used to, unconditionally) makes the undelivered remainder
  // permanently unreachable — `git diff head head` is empty forever after. Measured on a 2500-file
  // repo: 2000 files land, `✓ cloned 2000 files` prints, 500 are lost with no signal.
  //
  // With no cursor the CLI cannot self-heal, so the only honest move is to refuse loudly and name a
  // transport that has no cap.
  if (changes.truncated) {
    return {
      kind: 'incomplete',
      reason: 'this project has more changed files than one sync can carry, so nothing was applied.',
      details: [
        'Your folder was left exactly as it was — this is a refusal, not a partial sync.',
        'Use the git remote, which has no such limit:',
        '  git clone https://git.trivial.so/<owner>/<slug>',
      ],
    };
  }

  const current = await hashTree(folder);
  const local = diffLocal(current, state.files);
  const locallyChanged = new Set([...local.writes, ...local.deletes]);

  // Decode once — the apply loop and the convergence test both need the exact bytes, and
  // base64-decoding a large binary twice per pull is pure waste.
  const decoded = new Map<string, Buffer>();
  for (const f of changes.files) {
    if (f.status !== 'deleted' && typeof f.content === 'string') {
      // decode to the exact bytes and hash THOSE — the baseline must match what hashTree
      // reads back from disk, or every binary looks locally-changed forever.
      decoded.set(f.path, decodeWireContent(f.content, f.encoding));
    }
  }

  // ── CONVERGENCE ── a conflict is both sides moving to DIFFERENT content.
  //
  // This used to test path membership alone, which made the two transports unusable together: after
  // any `git push trivial` the cloud holds exactly what the folder holds, yet `state.files` still
  // describes the pre-push baseline, so every file you just pushed counted as changed on both sides
  // and `pull` refused wholesale. `trivial sync` skips its push half on a conflict, so it wedged
  // silently and permanently. That combination is not exotic — `trivial init` creates it and then
  // prints `git push trivial` as the next step.
  const isConverged = (f: ChangeFile): boolean => {
    if (f.status === 'deleted') return current[f.path] === undefined;
    const bytes = decoded.get(f.path);
    return bytes !== undefined && sha256(bytes) === current[f.path];
  };
  const conflicts = changes.files.filter((f) => locallyChanged.has(f.path) && !isConverged(f)).map((f) => f.path);

  // ── THE REBUILT PRUNE ── the headline bug, and the only thing here that deletes files.
  //
  // When the client's baseSha is not an ancestor of HEAD (a history rewrite, a restore, or simply
  // a nulled baseline), the server answers with the FULL HEAD tree as status 'added' and
  // `rebuilt: true`. A file the cloud DELETED is then merely ABSENT — there is no 'deleted' record
  // for the loop to act on. So the file survived on disk and in the baseline forever, and because
  // baseSha advanced the delete was never mentioned again. Editing that ghost afterwards re-pushed
  // it to the cloud, with no conflict and no warning.
  //
  // The candidate set is `state.cloud`, NOT `state.files` — see config.ts. Absence from a full-tree
  // payload does not mean "deleted"; it also means "never committed", and `state.files` is full of
  // paths in that class. Only a path we watched ARRIVE from the cloud and then watched disappear is
  // provably gone.
  const present = new Set(changes.files.map((f) => f.path));
  const knownCloud = state.cloud;
  const vanished = Boolean(changes.rebuilt) && knownCloud
    ? knownCloud.filter((p) => !present.has(p))
    : [];
  // A vanished path the maker has since edited is a real decision, not a cleanup: surface it as a
  // conflict rather than deleting their work.
  for (const p of vanished) {
    if (current[p] !== undefined && current[p] !== state.files[p] && !conflicts.includes(p)) conflicts.push(p);
  }

  // a RENAME's vacated path is part of the change too. The feed carries `oldPath` (the
  // server runs `git diff -M`, so `R100 old new` is routine), and a local edit to the file the
  // cloud renamed away is a genuine divergence — ignoring it meant the next push RESURRECTED the
  // old path on the cloud, undoing someone else's rename with no conflict shown.
  const renamedFrom = (f: ChangeFile): string | null =>
    f.status === 'renamed' && f.oldPath ? f.oldPath : null;
  for (const f of changes.files) {
    const from = renamedFrom(f);
    if (from && locallyChanged.has(from) && !conflicts.includes(from)) conflicts.push(from);
  }
  if (conflicts.length && !force) return { kind: 'conflict', files: conflicts };

  // ── APPLY ── contain per-file failures instead of aborting mid-loop.
  //
  // A single throw here (EISDIR, EEXIST, a Windows lock) used to abandon the pull AFTER some writes
  // had landed and BEFORE writeState, leaving the folder mutated and the baseline stale — the worst
  // of both. Collect instead, persist what landed, and refuse to advance baseSha so the next pull
  // re-offers the rest.
  const failures: string[] = [];

  // REMOVALS FIRST, then writes. Ordering is load-bearing: a rename can turn a file into a
  // directory (`src/config.ts` → `src/config/index.ts`) or a directory into a file, and doing the
  // writes first collides with the path still occupied by the old shape.
  const written = new Set(changes.files.filter((f) => f.status !== 'deleted').map((f) => f.path));
  const removals: string[] = [];
  for (const f of changes.files) {
    if (f.status === 'deleted') { removals.push(f.path); continue; }
    // NOT 'copied' — a copy leaves the original in place, by definition.
    const from = renamedFrom(f);
    // …and never remove a path this same payload also writes (a swap, or a rename into a path
    // another entry re-creates).
    if (from && !written.has(from)) removals.push(from);
  }
  // The prune's disk-delete rule, kept separate from the explicit removals above because the
  // evidence is weaker: the cloud told us the others were deleted, whereas these are inferred from
  // absence. Delete ONLY bytes provably identical to what we last received from the cloud; a
  // locally-modified one already became a conflict above, so reaching here means --force.
  for (const p of vanished) {
    if (current[p] === undefined) { delete state.files[p]; continue; }   // already gone locally
    // A locally-modified vanished path can only reach here under --force; without it, the loop
    // above turned it into a conflict and pullRemote already returned.
    removals.push(p);
  }

  for (const rel of removals) {
    try {
      await removeLocalPath(folder, rel);
      delete state.files[rel];
    } catch (e) {
      failures.push(`${rel} — could not remove: ${(e as Error).message}`);
    }
  }

  for (const f of changes.files) {
    if (f.status === 'deleted') continue;
    try {
      const bytes = decoded.get(f.path);
      if (!bytes) {
        // A non-deleted entry with no content: the server could not read the blob (an unreadable
        // path, a submodule gitlink). Silently skipping is how a wrong tree passes for a right one.
        failures.push(`${f.path} — the server sent no content for it`);
        continue;
      }
      // Already byte-identical (the convergence case): record the baseline, skip the write. A sync
      // loop would otherwise rewrite every converged file on every tick.
      if (sha256(bytes) !== current[f.path]) await writeLocalFile(folder, f.path, bytes);
      // Write it, but do NOT baseline a path hashTree cannot see (a committed `build/…`). `current`
      // could never contain it, so `diffLocal` would emit it as a local DELETE on every push, and
      // the write path refuses to delete a system-owned path — wedging push with an opaque 500.
      if (!isIgnoredPath(f.path)) state.files[f.path] = sha256(bytes);
    } catch (e) {
      failures.push(`${f.path} — ${(e as Error).message}`);
    }
  }

  // Repair, not just prevention: a folder synced by ≤0.14.0 already has such paths in its baseline
  // and is stuck until they leave. Dropping them is safe — diffLocal then proposes neither a write
  // nor a delete for a path it cannot see.
  for (const p of Object.keys(state.files)) if (isIgnoredPath(p)) delete state.files[p];

  // ── record what the cloud holds, for the NEXT prune ──
  // Updated only here, never by pushLocal: a pushed path may be accepted and then gitignored by the
  // server's `git add -A`, so a push is not evidence the cloud kept anything. A rebuilt payload IS
  // the full tree, so it replaces the set outright; an incremental one patches it.
  if (Boolean(changes.rebuilt)) {
    state.cloud = [...present].sort();
  } else {
    const next = new Set(knownCloud ?? []);
    for (const f of changes.files) {
      if (f.status === 'deleted') { next.delete(f.path); continue; }
      const from = renamedFrom(f);
      if (from) next.delete(from);
      next.add(f.path);
    }
    // Seed on the first incremental pull too, so a ≤0.14.0 folder gains provenance without waiting
    // for a rebuilt response. Partial (it knows only what it has seen), which is exactly why the
    // prune runs on rebuilt payloads only — those carry the whole tree.
    state.cloud = [...next].sort();
  }

  if (failures.length) {
    await writeState(folder, state);   // keep whatever did land
    return {
      kind: 'incomplete',
      reason: `${failures.length} file(s) could not be applied, so the sync point was not advanced.`,
      details: failures,
    };
  }

  // Only advance on a real answer. A server-side git failure (including the 20s timeout) returns
  // `{head: null, files: []}`, which used to NULL a healthy folder's baseline and silently promote
  // every following pull to a full re-sync.
  if (changes.head) state.baseSha = changes.head;
  await writeState(folder, state);
  return { kind: 'applied', count: changes.files.length, head: changes.head };
}

// ── push ── send the local diff. Returns an outcome (no die) for the same reason.
type PushOutcome =
  | { kind: 'nothing' }
  | { kind: 'pushed'; writes: number; deletes: number; commit: string }
  | { kind: 'conflict' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'over_quota' }
  | { kind: 'error'; status: number };
async function pushLocal(folder: string, state: State, token: string, message: string): Promise<PushOutcome> {
  const current = await hashTree(folder);
  const { writes, deletes, skipped, withheld } = diffLocal(current, state.files);
  // a withheld path WOULD be accepted by the write path but can never
  // be committed (the server force-merges .env/.env.*/*.log into .gitignore),
  // so it would be invisible to every pull/clone AND would still be read by the
  // build — Vite inlines VITE_* into the public bundle. Say so once, plainly.
  if (withheld.length) {
    console.log(`  ℹ not pushing ${withheld.length} file(s) the cloud can never store: ${withheld.join(', ')}`);
    console.log('    .env / *.local / *.log are gitignored server-side, so they would upload but never');
    console.log('    appear in any clone — while still feeding the build. Keep them on your machine.');
  }
  // Never silently drop: a skipped path is a real local change the platform will not accept.
  if (skipped.length) {
    console.log(`  ℹ not pushing ${skipped.length} platform-managed file(s): ${skipped.join(', ')}`);
    console.log('    the platform maintains these (its installer owns the lockfiles) — your local copy is fine to keep.');
  }
  if (!writes.length && !deletes.length) return { kind: 'nothing' };
  // binary files ride base64 with an explicit encoding; text stays plain.
  // The JSON body cap is 5 MB server-side, so an oversized binary is refused
  // HERE with its name instead of dying as an opaque 413.
  const MAX_BINARY_BYTES = 7 * 1024 * 1024;
  const encoded: WriteSetFile[] = [];
  for (const p of writes) {
    const bytes = await readLocalBytes(folder, p);
    if (!isBinaryBuffer(bytes)) { encoded.push({ path: p, content: bytes.toString('utf8') }); continue; }
    if (bytes.length > MAX_BINARY_BYTES) {
      return { kind: 'invalid', reason: `${p} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — binary files over ~7 MB can't ride the folder path yet; add it through the web interface instead.` };
    }
    encoded.push({ path: p, content: bytes.toString('base64'), encoding: 'base64' });
  }
  const files: WriteSetFile[] = [
    ...encoded,
    ...deletes.map((p) => ({ path: p, op: 'delete' as const })),
  ];
  const { status, body } = await pushWriteSet(state.apiUrl, state.projectId, token, state.baseSha, message, files);
  if (status === 200) {
    state.baseSha = body.commit ?? state.baseSha;
    state.files = current;
    await writeState(folder, state);
    return { kind: 'pushed', writes: writes.length, deletes: deletes.length, commit: body.commit };
  }
  if (status === 409) return { kind: 'conflict' };
  if (status === 422) return { kind: 'invalid', reason: body.errors?.[0]?.reason ?? 'a file failed validation' };
  if (status === 403) {
    // Brick 5: the project requires review — retrying the push can never work, so point at the way that does.
    if (body.error === 'requires_review') return { kind: 'forbidden', message: `${body.message ?? 'this project requires review'}\n  try: trivial propose -m "..."` };
    const msg = body.message ?? body.error ?? 'a protected path, or the token lacks write access';
    // A viewer can still contribute — point the no-edit-access 403 at the review path.
    const hint = /edit access/i.test(msg) ? '\n  you have view access — `trivial propose -m "..."` sends your changes for review instead' : '';
    return { kind: 'forbidden', message: msg + hint };
  }
  if (status === 413) return { kind: 'over_quota' };
  return { kind: 'error', status };
}

type ProposeOutcome =
  | { kind: 'nothing' }
  | { kind: 'proposed'; id: string; writes: number; deletes: number }
  | { kind: 'empty' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; status: number };

/**
 * Send the local changes as a PROPOSAL instead of writing them.
 *
 * The two ways this deliberately differs from pushLocal:
 *  - a `project:read` token is enough, because proposing is not writing — this is how someone with
 *    review access contributes at all;
 *  - the local baseline is NOT advanced. A proposal hasn't landed on main, so the folder genuinely still
 *    differs from the cloud, and `trivial status` must keep saying so. Advancing it here would quietly
 *    tell the user their work was applied when it is still waiting for review.
 */
async function proposeLocal(folder: string, state: State, token: string, message: string): Promise<ProposeOutcome> {
  const current = await hashTree(folder);
  const { writes, deletes, skipped, withheld } = diffLocal(current, state.files);
  // see the note in pushLocal: withheld paths would be accepted but
  // never committed, so they can never reach the maker reviewing this proposal.
  if (withheld.length) {
    console.log(`  ℹ not proposing ${withheld.length} file(s) the cloud can never store: ${withheld.join(', ')}`);
  }
  // Same rule as push: a proposal carrying a platform-managed path would be refused whole.
  if (skipped.length) {
    console.log(`  ℹ not proposing ${skipped.length} platform-managed file(s): ${skipped.join(', ')}`);
  }
  if (!writes.length && !deletes.length) return { kind: 'nothing' };
  // binary files ride proposals base64 too — same detection, same
  // ceiling, same by-name refusal for oversized ones as push.
  const MAX_PROPOSAL_BINARY = 7 * 1024 * 1024;
  const proposalFiles: Array<{ path: string; content: string | null; encoding?: 'base64' }> = [];
  for (const p of writes) {
    const bytes = await readLocalBytes(folder, p);
    if (!isBinaryBuffer(bytes)) { proposalFiles.push({ path: p, content: bytes.toString('utf8') }); continue; }
    if (bytes.length > MAX_PROPOSAL_BINARY) {
      return { kind: 'invalid', reason: `${p} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — binary files over ~7 MB can't ride the folder path yet; add it through the web interface instead.` };
    }
    proposalFiles.push({ path: p, content: bytes.toString('base64'), encoding: 'base64' });
  }
  const files = [
    ...proposalFiles,
    ...deletes.map((p) => ({ path: p, content: null })),
  ];
  const { status, body } = await createProposal(state.apiUrl, state.projectId, token, message, files);
  if (status === 201) return { kind: 'proposed', id: body.id, writes: writes.length, deletes: deletes.length };
  if (status === 409) return { kind: 'empty' };
  if (status === 403) return { kind: 'forbidden', message: body.message ?? body.error ?? 'not a member of this project' };
  if (status === 400 || status === 413) return { kind: 'invalid', reason: body.error ?? 'the proposal was rejected' };
  return { kind: 'error', status };
}

async function cmdPropose(args: Args): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  const message = (args.flags.message as string) || 'suggestion from CLI';
  const out = await proposeLocal(folder, state, token, message);
  switch (out.kind) {
    case 'nothing': console.log('✓ nothing to propose — no local changes.'); return;
    case 'proposed':
      console.log(`✓ proposed ${out.writes} change(s), ${out.deletes} deletion(s) → ${out.id}`);
      console.log('  the maker sees it in Changes. Your folder still differs from the cloud until they accept.');
      return;
    case 'empty': die('nothing to propose — your files match the project as it is.');
    case 'forbidden': die(`rejected: ${out.message}`);
    case 'invalid': die(`rejected: ${out.reason}`);
    case 'error': die(`propose failed (HTTP ${out.status}).`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A clone ref: `owner/slug`, a project URL (https://trivial.so/owner/slug), or a bare project id. */
function parseCloneRef(raw: string): { owner: string; slug: string } | { id: string } | null {
  const s = raw.trim();
  const url = s.match(/^https?:\/\/[^/]+\/(?:p\/)?([^/?#]+)\/([^/?#]+)/);
  if (url) return { owner: url[1].replace(/^@/, ''), slug: url[2] };
  if (UUID_RE.test(s)) return { id: s };
  const parts = s.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) return { owner: parts[0].replace(/^@/, ''), slug: parts[1] };
  return null;
}

/**
 * A clone that produced nothing is not a success, whatever the exit code says.
 *
 * ── THE ADVICE CHANGED WITH PHASE 2c; THE WARNING DID NOT GO AWAY ────────────────────────────────
 * This used to say a project's history is created by its FIRST PUBLISH — measured, and true at the
 * time: `.git` was absent on create, absent after a build-preview, absent after an editor or Trio
 * write, and present only after a publish.
 *
 * The ledger's flusher makes that false. Any write now becomes a commit within the drift ceiling, so
 * "publish it once" is no longer the instruction — editing is enough, and waiting a moment is the
 * rest of it.
 *
 * The collaboration-layer plan said to DELETE this function once 2c landed. That is a step too far:
 * the CONDITION it detects is still real. A project created and never touched has nothing to clone,
 * and on a deployment with the ledger off the old behaviour is exactly what a maker gets. What was
 * wrong was the explanation, not the warning — so the explanation is what changes.
 *
 * Shared by BOTH clone forms; the token form is the agent/CI path, which used to print a bare
 * "✓ cloned 0 files" — a success-shaped message for a total failure, to the caller least able to
 * notice.
 */
function warnIfEmptyClone(count: number, baseSha: string | null): void {
  if (count > 0 || baseSha) return;
  console.log('  ⚠ nothing was cloned — this project has no synced history yet.');
  console.log('    Make an edit (in the app, or with `trivial push`), then `trivial pull`.');
}

/**
 * Is `dir` safe to scaffold into? Empty-or-absent is yes; anything else is a refusal.
 *
 * This guards `create`, whose whole job is to lay a scaffold — writing one into someone's existing
 * codebase would silently overwrite their files. It is no longer a guard against *ingest*:
 * retired  #2 and `trivial init` now adopts an existing folder deliberately. Dotfiles a
 * shell leaves behind (`.DS_Store`) don't count as content; a real repo does.
 */
async function dirBlockers(dir: string): Promise<string[]> {
  let entries: string[];
  try { entries = await fsp.readdir(dir); } catch { return []; }  // absent → we create it
  const IGNORE = new Set(['.DS_Store', 'Thumbs.db', '.', '..']);
  return entries.filter((e) => !IGNORE.has(e));
}

/**
 * `trivial init` — RENAMED. This verb used to create a new project; it now adopts the
 * folder you are standing in, and `trivial create` does what `init` used to do.
 *
 * The old forms hard-error for one minor version instead of being silently reinterpreted. That is
 * deliberate: reinterpreting `trivial init my-app` under the new meaning would adopt the CURRENT
 * folder into a project named "my-app" — creating a project from the wrong tree, which is both
 * surprising and, for anyone with a large repo one directory up, expensive.
 */
function dieOnOldCreateForm(args: Args): void {
  const title = args.positional[0];
  const here = Boolean(args.flags.here);
  if (!title && !here) return;
  const suggestion = title ? `trivial create ${title}` : 'trivial create --here';
  die(`\`trivial init ${title ?? '--here'}\` no longer creates a project.\n`
    + '  `init` now adopts THIS folder into a new project (it takes no name).\n'
    + `  To scaffold a new project, use:  ${suggestion}`);
}

// ── create ── a new project, from the terminal. Create + the clone we already have.
async function cmdCreate(args: Args): Promise<void> {
  const apiUrl = (args.flags.api as string) || DEFAULT_API;
  const token = await getUserToken(apiUrl);
  if (!token) die('not logged in — run `trivial login` first.');

  const title = args.positional[0];
  // Default to a SUBDIRECTORY, the way `git clone` does — so the common case never has to reason
  // about what is already in the shell's cwd. `--here` is the explicit opt-in.
  const here = Boolean(args.flags.here);
  if (here && title) die('pass a name or --here, not both: --here uses this folder and the project takes its name from it.');

  const dir = here ? '.' : (title ? title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : null);
  if (!here && !dir) die('usage: trivial create <name>   (or `trivial create --here` in an empty folder)');

  const blockers = await dirBlockers(dir!);
  if (blockers.length) {
    const looksLikeCode = blockers.some((f) => ['package.json', '.git', 'src', 'Cargo.toml', 'go.mod', 'pyproject.toml'].includes(f));
    if (looksLikeCode) {
      // This refusal used to end the conversation ("we don't import an existing repo"). It now
      // hands over to the verb that does — which is the whole point of the  split, and
      // and it retires an old refusal: a folder holding only `.git` was called "a codebase" and turned away,
      // when adopting it is exactly what that person wanted.
      // name what is actually there. A folder holding nothing but `.git` is a repository,
      // not "a codebase", and calling it one is a small false statement at the first thing a
      // developer sees. The hand-over is the same either way.
      const onlyGit = blockers.length === 1 && blockers[0] === '.git';
      const what = onlyGit
        ? 'already has a git repository'
        : `already contains a codebase (${blockers.slice(0, 4).join(', ')}${blockers.length > 4 ? ', …' : ''})`;
      die(`${here ? 'this folder' : dir + '/'} ${what}.\n`
        + '  `trivial create` scaffolds a NEW project, so it needs an empty folder.\n'
        + `  To bring THIS code to Trivial instead:  ${here ? '' : `cd ${dir} && `}trivial init`);
    }
    die(`${here ? 'this folder' : dir + '/'} is not empty (${blockers.slice(0, 4).join(', ')}${blockers.length > 4 ? ', …' : ''}) — create needs an empty folder so it can\'t overwrite anything.`);
  }

  const proj = await createProject(apiUrl, token, title ? { title } : {});
  // Creation always allocates `untitled-N` — the browser's flow is "draft now, name it later". A
  // maker who typed a name has already done the naming, so claim it. Best-effort: a taken slug is
  // real (two projects, same idea) and is not worth failing a successful creation over — you keep
  // the project and the folder, and the slug stays untitled-N.
  let slug = proj.projectSlug;
  if (title && dir) {
    const renamed = await renameProject(apiUrl, proj.projectId, token, dir, title);
    if (renamed) slug = renamed.slug;
    else console.log(`  ℹ kept the name "${proj.projectSlug}" — "${dir}" was already taken.`);
  }
  // GIT FIRST here too: a project you just scaffolded deserves the same folder as one you clone —
  // history from its `baseline: scaffold` commit, and a wired remote. `dirBlockers` above already
  // proved the folder is empty-or-absent, which is what `git clone` needs.
  if (!gitOptedOut(args)) {
    const me = await whoami(apiUrl, token).catch(() => null);
    const owner = me?.user?.username;
    if (owner) {
      const g = await cloneWithGit({
        apiUrl, projectId: proj.projectId, owner, slug, dir: dir!,
        gitUrlFlag: args.flags['git-url'] as string | undefined,
      });
      if (g.ok && g.count > 0) {
        console.log(`✓ created ${slug} → ${here ? 'this folder' : dir + '/'}  (${g.count} files, with history)`);
        console.log(`  git remote "trivial" → ${g.url}`);
        printCreateNextSteps(here, dir!);
        return;
      }
      // A zero-file git clone is the same condition wearing a different hat (the repo exists but
      // the scaffold has not landed in it yet). Fall through to the feed, which knows how to say so.
      if (!g.ok) console.log(`  ℹ no git history in this folder (${g.reason}) — taking a snapshot instead.`);
    }
  }

  const state: State = { apiUrl, projectId: proj.projectId, ref: slug, baseSha: null, files: {} };
  await writeState(dir!, state);
  const out = await pullRemote(dir!, state, token, true);
  // never fall through to the success line on an incomplete pull — and never to the
  // "scaffolded empty" warning either, which would report a transport refusal as a platform bug.
  if (out.kind === 'incomplete') {
    die(`${incompleteText(out)}\n  The project "${slug}" WAS created — clone it once the cause is fixed.`);
  }
  const count = out.kind === 'applied' ? out.count : 0;

  console.log(`✓ created ${slug} → ${here ? 'this folder' : dir + '/'}  (${count} files)`);
  //  is why this can be an assertion rather than a hope: the repo now exists from creation, so
  // a fresh project clones with its scaffold. A zero here means that regressed.
  if (count === 0) {
    console.log('⚠ the project scaffolded empty — that is a bug; report it rather than working around it.');
  }
  printCreateNextSteps(here, dir!);
}

function printCreateNextSteps(here: boolean, dir: string): void {
  console.log('\nnext:');
  if (!here) console.log(`  cd ${dir}`);
  console.log('  pnpm install');
  console.log('  trivial dev            # run it locally, with its data');
  console.log('  trivial publish        # put it on the internet');
}

/** `https://api.trivial.so` → `https://git.trivial.so`. The credential helper already relies on
 *  api-and-git living under one parent domain (git-credential.ts `apiUrlForGitHost`); this is that
 *  rule read backwards. `--git-url` overrides it for a local mirror, whose git port differs. */
function gitBaseForApi(apiUrl: string): string | null {
  try {
    const u = new URL(apiUrl);
    const apex = u.hostname.replace(/^api\./, '');
    return `${u.protocol}//git.${apex}`;
  } catch { return null; }
}

// ── init ── adopt THIS folder into a new project.
//
// The transport is GIT, not the write-set. See cli/src/git.ts for why: the write-set's MAX_FILES
// =1000 and ~7 MB body ceiling are transport properties, and adoption is exactly the case that
// exceeds them. The git vhost takes 512 MB and caps no file count.
async function cmdInit(args: Args): Promise<void> {
  dieOnOldCreateForm(args);

  const apiUrl = (args.flags.api as string) || DEFAULT_API;
  const token = await getUserToken(apiUrl);
  if (!token) die('not logged in — run `trivial login` first.');

  const cwd = process.cwd();
  if (await readState(cwd)) {
    die('this folder is already a Trivial project (.trivial/state.json is here).\n'
      + '  `trivial status` shows where it stands.');
  }

  // ── the preconditions, each with the reason attached ──
  if (!(await gitAvailable(cwd))) die('adoption needs git on your PATH — it pushes your repo to Trivial over git.');
  if (!(await isRepo(cwd))) {
    die('this folder is not a git repository.\n'
      + '  Adoption pushes your commits, so git is how your code travels. Start one:\n'
      + '    git init && git add -A && git commit -m "initial"\n'
      + '  …then run `trivial init` again.');
  }
  const root = await repoRoot(cwd);
  if (root && root !== cwd) {
    // git pushes the WHOLE tree, not the directory you happen to stand in. Adopting from `src/`
    // would silently send everything above it — including whatever else lives in that repo.
    die(`this is a subdirectory of the repo at ${root}.\n`
      + '  git pushes the whole repository, so adopt from its root instead:\n'
      + `    cd ${root} && trivial init`);
  }
  const head = await headSha(cwd);
  if (!head) {
    die('this repository has no commits yet — adoption pushes what git has committed.\n'
      + '  Make the first one:  git add -A && git commit -m "initial"');
  }

  const tracked = await trackedFiles(cwd);
  if (tracked.length === 0) die('HEAD has no files — there is nothing to adopt yet.');

  const name = (args.flags.name as string) || cwd.split(/[/\\]/).filter(Boolean).pop() || 'app';
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

  const gitBase = (args.flags['git-url'] as string) || gitBaseForApi(apiUrl);
  if (!gitBase) die(`could not work out the git host for ${apiUrl} — pass --git-url https://git.example.com`);
  if (await remoteUrl(cwd, 'trivial')) {
    die('this repo already has a remote named "trivial".\n'
      + '  If it is already adopted, push to it directly; otherwise rename or remove that remote first.');
  }

  // ── what we are about to do, before we do it ──
  const sizeKb = await packedSizeKb(cwd);
  const dirty = await isDirty(cwd);
  console.log(`adopt ${cwd}`);
  console.log(`  ${tracked.length} tracked file(s)${sizeKb ? `, ~${(sizeKb / 1024).toFixed(1)} MB of git objects` : ''}`);
  console.log(`  → a new project "${slug}" on ${apiUrl.replace(/^https?:\/\//, '')}`);
  if (sizeKb && sizeKb > 25 * 1024) {
    console.log(`  ⚠ that is a large repo. Storage is quota-capped per plan (Basic 100 MB, holding`);
    console.log('    source AND every published release) — the server will refuse over it.');
  }
  if (dirty) {
    console.log('  ⚠ you have uncommitted changes. Adoption pushes HEAD, so they will NOT be included');
    console.log('    — commit them first if the project should match what you see on disk.');
  }
  console.log('\nwhat works with code we did not scaffold:');
  console.log('  ✓ build + publish        — any repo whose build writes static files');
  console.log('  ✓ preview on the canvas  — after the first successful build');
  console.log('  ✗ click-to-edit + code round-trip — our Vite + React scaffold only');
  console.log('  Your own git remote is untouched. Trivial is added alongside it.\n');
  if (!args.flags.yes) {
    if (!process.stdin.isTTY) die('not a terminal — re-run with --yes to adopt non-interactively.');
    if (!(await promptYesNo('continue? [y/N] '))) { console.log('✓ nothing created.'); return; }
  }

  // ── create the project EMPTY, then push the real tree into it ──
  const proj = await createProject(apiUrl, token, { title: name, scaffold: 'none' });
  let finalSlug = proj.projectSlug;
  const renamed = await renameProject(apiUrl, proj.projectId, token, slug, name);
  if (renamed) finalSlug = renamed.slug;
  else console.log(`  ℹ kept the name "${proj.projectSlug}" — "${slug}" was already taken.`);

  const me = await whoami(apiUrl, token).catch(() => null);
  const owner = me?.user?.username;
  if (!owner) die('could not resolve your username — the git remote URL needs it. Try `trivial whoami`.');
  const url = `${gitBase}/${owner}/${finalSlug}`;

  // The credential helper, scoped to THIS repo: the token never lands in .git/config, in
  // `git remote -v`, in shell history, or in a screenshot (the reason  built the helper).
  await git(cwd, ['config', `credential.${gitBase}.helper`, '!trivial git-credential']);
  const added = await git(cwd, ['remote', 'add', 'trivial', url]);
  if (added.code !== 0) die(`could not add the git remote: ${added.out}`);

  // Never assume the branch — see remoteHeadBranch.
  const branch = await remoteHeadBranch(cwd, url);
  if (!branch) {
    die(`the project was created, but its git remote did not answer.\n  Retry the push yourself:  git push trivial HEAD:main\n  (if that is the wrong branch the remote will say so, and name the right one)\n  (remote: ${url})`);
  }

  // --force is safe here and ONLY here: the project was created seconds ago by this same command,
  // and the only thing on that branch is the one-file `.gitignore` baseline `ensureRepo` wrote. The
  // developer's history is unrelated to it, so a fast-forward is impossible by construction.
  console.log(`\npushing ${tracked.length} file(s) → ${owner}/${finalSlug} (${branch})…`);
  const pushed = await git(cwd, ['push', '--force', 'trivial', `HEAD:${branch}`], { timeoutMs: 600_000 });
  if (pushed.code !== 0) {
    die(`the push failed, but the project "${finalSlug}" exists and the remote is wired.\n`
      + `${pushed.out.split('\n').map((l) => '    ' + l).join('\n')}\n`
      + `  Fix the cause and retry:  git push trivial HEAD:${branch}`);
  }

  // The baseline must describe what the SERVER now holds, which is HEAD's tracked tree. Build it
  // from the intersection of the tracked set and what hashTree can see: a tracked file that
  // hashTree skips (something committed under build/, say) would otherwise sit in the baseline
  // with no local counterpart and read as a DELETE on the next push.
  //
  // …and EXCLUDE paths whose working copy differs from HEAD. We pushed HEAD, so for a dirty file
  // the cloud holds the COMMITTED bytes while hashTree reports the DIRTY ones. Baselining the dirty
  // hash would claim the cloud already has that work: `trivial status` would report clean, `push`
  // would send nothing, and the uncommitted edits would never reach Trivial at all — the warning
  // above says they are "not included", and this is what makes that recoverable rather than
  // permanent. Left out of the baseline, they show up as ordinary local changes to push.
  const local = await hashTree(cwd);
  const trackedSet = new Set(tracked);
  const dirtyPaths = new Set(await modifiedAgainstHead(cwd));
  const files: Record<string, string> = {};
  for (const [p, h] of Object.entries(local)) if (trackedSet.has(p) && !dirtyPaths.has(p)) files[p] = h;
  await writeState(cwd, {
    apiUrl, projectId: proj.projectId, ref: finalSlug, baseSha: head, files,
    // Provenance from the start: the cloud holds exactly the tree we just pushed. Recording
    // it here means an adopted folder can be pruned correctly on its first full re-sync instead of
    // having to skip one.
    cloud: [...tracked].sort(),
  });

  console.log(`✓ adopted → ${owner}/${finalSlug}`);
  console.log('\nnext:');
  console.log('  trivial build          # run your build the way Trivial will');
  console.log('  trivial publish        # put it on the internet');
  console.log('  git push trivial       # send later commits (or `trivial push`)');
}

/**
 * `trivial git-credential <get|store|erase>` — git's credential-helper protocol.
 *
 * Not for humans to run: git invokes it, hands it a request on stdin, and reads the answer on
 * stdout. Configured once (`git config credential.https://git.trivial.so.helper '!trivial
 * git-credential'`), it means `git push` authenticates from the credential `trivial login` already
 * stored — so nobody ever pastes a token into a remote URL, where it would land in .git/config,
 * `git remote -v`, shell history, and screenshots.
 *
 * Silence is a valid answer: for any host we don't serve, it writes nothing and exits 0, and git
 * moves on to its next helper or prompts. That is what makes it safe to configure globally.
 */
async function cmdGitCredential(args: Args): Promise<void> {
  const verb = args.positional[0] || '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const { runGitCredential } = await import('./git-credential.js');
  const out = await runGitCredential(verb, Buffer.concat(chunks).toString('utf8'));
  if (out) process.stdout.write(out);
}

/**
 * Write `src/trivial.config.json` if the clone did not receive one.
 *
 * ── WHY THE CLI SYNTHESIZES A FILE THE SERVER GENERATES ──────────────────────────────────────────
 * That file is build output living in the source tree: the server regenerates it on every publish,
 * and Phase 2a wants it OUT of git along with the other three injected files, so a project's repo
 * stops being permanently dirty. It is the one of the four that cannot simply be untracked, because
 * it is load-bearing on this side: vite static-imports it (`src/lib/trivial-auth.ts`), and this CLI
 * reads it to recognise a folder as a Trivial project when there is no `.trivial/state.json`.
 *
 * So the clone writes it locally instead of receiving it. No server round-trip is needed — the only
 * field a local build or `trivial dev` actually needs is `projectId`, which the clone already has.
 *
 * This is strictly better than what a clone gets today, which is the TRACKED placeholder: an
 * all-empty object with no projectId at all. A maker who clones and runs `trivial dev` currently
 * relies on `.trivial/state.json`; after this the fallback path works too.
 *
 * Never overwrites. If the tree already carries a config — an existing clone, or a project whose
 * copy is still tracked — that file wins, because it may hold real auth values this cannot know.
 */
async function ensureLocalConfig(folder: string, projectId: string): Promise<void> {
  const rel = join('src', 'trivial.config.json');
  const abs = join(folder, rel);
  try { await fsp.access(abs); return; } catch { /* absent — write it */ }
  try {
    await fsp.mkdir(dirname(abs), { recursive: true });
    // The same shape the preview shell serves for this file, so a local build and the hosted
    // preview agree about what "unconfigured" looks like. Empty strings rather than omitted keys:
    // the SDK reads the fields, and `isAuthConfigured()` keys on authOrg being falsy.
    await fsp.writeFile(abs, `${JSON.stringify({
      projectId, dataApiBaseUrl: '', authIssuer: '', authClientId: '', authOrg: '',
    }, null, 2)}\n`, 'utf8');
  } catch { /* best-effort: a clone that works without it is better than a clone that fails */ }
}

/**
 * Materialize a project into `dir` as a REAL GIT CLONE, and lay the CLI's own state on top.
 *
 * ── WHY THE DEFAULT MOVED TO GIT ─────────────────────────────────────────────────────────────────
 * The folder path (the `/changes` feed) exists so someone with no git at all can still work, and it
 * stays the fallback for exactly that person. But when git IS present, handing a maker a folder with
 * no `.git` costs them things we already have and they cannot reconstruct: the project's history,
 * its per-person attribution ( — commits are authored to `<username>@users.trivial.so`), and
 * a transport with no size ceiling. The feed pages at 8 MB and REFUSES a tree it cannot carry, at
 * which point it tells the maker to go use `git clone` anyway.
 *
 * It also removes a real confusion: `trivial init` REQUIRES git and pushes over it, while clone
 * hid git entirely — so the same tool told two different stories about how code travels, and a
 * folder with no `.git` reads as "the git substrate is broken" to anyone who looks.
 *
 * ── STATE, AND WHY `cloud` IS THE TRACKED SET ────────────────────────────────────────────────────
 * `files` is the LOCAL baseline (hashTree, which skips `.git`/`.trivial` by construction), taken
 * AFTER `ensureLocalConfig` so a synthesized `src/trivial.config.json` is baselined rather than
 * read as a local add on the next status. `cloud` is what the CLOUD is known to hold, which is
 * exactly git's tracked set — never the hashTree keys, or a locally-synthesized file would be
 * recorded as cloud provenance and the next full re-sync would prune it.
 *
 * Returns `{ ok: false, reason }` for every failure — no git, no repo yet, auth, network. Each one
 * means "fall back to the feed", never "fail the command".
 */
async function cloneWithGit(opts: {
  apiUrl: string; projectId: string; owner: string; slug: string; dir: string; gitUrlFlag?: string;
}): Promise<{ ok: true; count: number; baseSha: string | null; url: string } | { ok: false; reason: string }> {
  const { apiUrl, projectId, owner, slug, dir } = opts;
  if (!(await gitAvailable(process.cwd()))) return { ok: false, reason: 'git is not on your PATH' };
  const gitBase = opts.gitUrlFlag || gitBaseForApi(apiUrl);
  if (!gitBase) return { ok: false, reason: `could not work out the git host for ${apiUrl}` };
  const url = `${gitBase}/${owner}/${slug}`;

  const cloned = await cloneRepo(gitBase, url, dir);
  if (cloned.code !== 0) {
    // One line, not git's whole stderr: the fallback is about to succeed, so this is a note, not a
    // failure report. `--verbose`-grade detail belongs to whoever debugs it with git directly.
    return { ok: false, reason: firstLine(cloned.out) || `git clone exited ${cloned.code}` };
  }

  await ensureLocalConfig(dir, projectId);
  const files = await hashTree(dir);
  const tracked = await trackedFiles(dir);
  const baseSha = await headSha(dir);
  await writeState(dir, {
    apiUrl, projectId, ref: `${owner}/${slug}`, baseSha, files, cloud: [...tracked].sort(),
  });
  return { ok: true, count: tracked.length, baseSha, url };
}

/** git's first line of complaint, which is the one that says what happened. */
function firstLine(text: string): string {
  return (text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '').replace(/^fatal:\s*/, '');
}

/** Did the caller opt out of the git transport? `--no-git` on clone/create. */
function gitOptedOut(args: Args): boolean {
  return Boolean(args.flags['no-git']);
}

async function cmdClone(args: Args): Promise<void> {
  const apiUrl = (args.flags.api as string) || DEFAULT_API;

  // Explicit-token form (the web UI's per-project panel, agents/CI): both flags, no resolution.
  //
  // NO GIT PATH HERE, deliberately. The credential helper serves only the USER-level login — it
  // skips per-project keys outright (`git-credential.ts`: `if (key.includes('|')) continue`) — so a
  // project-scoped `trv_` token cannot authenticate a `git clone` at all. Reaching for git here
  // would 401 on every agent/CI run and fall back anyway, one wasted network round trip per clone.
  // The feed is this form's transport by design, not by omission.
  const flagProject = args.flags.project as string | undefined;
  const flagToken = args.flags.token as string | undefined;
  if (flagProject && flagToken) {
    const dir = args.positional[0] || flagProject;
    await setToken(apiUrl, flagProject, flagToken);
    const state: State = { apiUrl, projectId: flagProject, baseSha: null, files: {} };
    await writeState(dir, state);
    const out = await pullRemote(dir, state, flagToken, true);
    if (out.kind === 'incomplete') await abandonClone(dir, out);
    const count = out.kind === 'applied' ? out.count : 0;
    await ensureLocalConfig(dir, state.projectId);
    console.log(`✓ cloned ${count} files into ${dir}/  (@ ${short(state.baseSha)})`);
    warnIfEmptyClone(count, state.baseSha);
    return;
  }

  // Logged-in form: clone by ref (owner/slug, URL, or id) with the `trivial login` credential.
  const refFromPositional = args.positional[0] ? parseCloneRef(args.positional[0]) : null;
  const ref = refFromPositional ?? (flagProject ? { id: flagProject } : null);
  if (!ref) {
    die('usage: trivial clone <owner>/<slug> [dir]\n  (list yours with `trivial projects`; or the token form: trivial clone --project <id> --token trv_...)');
  }
  const token = await getUserToken(apiUrl);
  if (!token) die('not logged in — run `trivial login` first.');
  const proj = await resolveProject(apiUrl, token!, ref);
  const dir = refFromPositional ? (args.positional[1] || proj.slug) : (args.positional[0] || proj.slug);

  // GIT FIRST. The feed is the fallback, not the default — see cloneWithGit.
  if (!gitOptedOut(args) && proj.owner) {
    const g = await cloneWithGit({
      apiUrl, projectId: proj.id, owner: proj.owner, slug: proj.slug, dir,
      gitUrlFlag: args.flags['git-url'] as string | undefined,
    });
    if (g.ok) {
      console.log(`✓ cloned ${proj.owner}/${proj.slug} → ${dir}/  (${g.count} files @ ${short(g.baseSha)}, with history)`);
      console.log(`  git remote "trivial" → ${g.url}  —  \`git pull\` / \`git push\` work here.`);
      warnIfEmptyClone(g.count, g.baseSha);
      return;
    }
    console.log(`  ℹ no git history in this clone (${g.reason}) — taking a snapshot instead.`);
  }

  const state: State = { apiUrl, projectId: proj.id, ref: proj.owner ? `${proj.owner}/${proj.slug}` : undefined, baseSha: null, files: {} };
  await writeState(dir, state);
  const out = await pullRemote(dir, state, token!, true);
  if (out.kind === 'incomplete') await abandonClone(dir, out);
  const count = out.kind === 'applied' ? out.count : 0;
  await ensureLocalConfig(dir, state.projectId);
  console.log(`✓ cloned ${proj.owner ?? '?'}/${proj.slug} → ${dir}/  (${count} files @ ${short(state.baseSha)})`);
  warnIfEmptyClone(count, state.baseSha);
}

/** Read a secret from the terminal without echoing (and without it touching argv/history). */
function promptSecret(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    const onData = (chunk: Buffer) => {
      for (const c of chunk.toString('utf8')) {
        if (c === '\n' || c === '\r' || c === '\u0004') {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause(); stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(buf.trim());
          return;
        }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(1); } // Ctrl+C in raw mode
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function cmdLogin(args: Args): Promise<void> {
  const apiUrl = (args.flags.api as string) || DEFAULT_API;

  // Paste form. `--token trv_…` still works, but the value can (and should) stay out of
  // shell history: bare `--token` reads $TRIVIAL_TOKEN, else prompts without echo.
  let pasted = typeof args.flags.token === 'string' ? args.flags.token : undefined;
  if (args.flags.token === true) {
    pasted = process.env.TRIVIAL_TOKEN || await promptSecret('  paste token (input hidden): ');
    if (!pasted) die('no token provided.');
  }

  // Inside a cloned folder a paste stays PROJECT-scoped (the agent/CI path); anywhere else
  // the pasted token is saved as this machine's user-level credential for the API.
  if (pasted) {
    if (!pasted.startsWith('trv_')) die('that does not look like a Trivial token (trv_...)');
    const state = await readState(process.cwd());
    if (state) {
      await setToken(state.apiUrl, state.projectId, pasted);
      console.log('✓ token saved for this project.');
    } else {
      await setUserToken(apiUrl, pasted);
      console.log(`✓ token saved for ${apiUrl}.`);
    }
    return;
  }

  // Already signed in with a working credential? Say so instead of silently minting
  // another key (--force starts a fresh sign-in anyway; the old key gets revoked on success).
  if (!args.flags.force) {
    const existing = await getUserToken(apiUrl);
    if (existing) {
      try {
        const { user } = await whoami(apiUrl, existing);
        console.log(`✓ already logged in as ${user.username ?? user.id} — \`trivial login --force\` to sign in again, \`trivial logout\` to switch accounts.`);
        return;
      } catch { /* stale/revoked — fall through to a fresh sign-in */ }
    }
  }

  // Browser sign-in (device flow) — one login, all your projects.
  let label = 'trivial CLI';
  try { label = `${userInfo().username}@${hostname()}`; } catch { /* keep default */ }
  const start = await startDeviceLogin(apiUrl, label);
  console.log('\n  Open this page to sign in:');
  console.log(`    ${start.verificationUriComplete}`);
  console.log(`  and confirm this code:  ${start.userCode}\n`);
  openBrowser(start.verificationUriComplete);
  process.stdout.write('  waiting for approval in the browser … ');

  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(1, start.interval) * 1000);
    let poll;
    try {
      poll = await pollDeviceLogin(apiUrl, start.deviceCode, start.userCode);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) die('sign-in expired before it was approved — run `trivial login` again.');
      if (e instanceof HttpError && e.status === 429) continue; // backed off by the next sleep
      continue; // transient network blip — keep waiting until the deadline
    }
    if (poll.status === 'approved') {
      // Replacing an earlier login? Revoke the old key server-side — otherwise every
      // re-login strands a live credential in the account's key list. Best-effort.
      const prev = await getUserToken(apiUrl);
      await setUserToken(apiUrl, poll.token);
      if (prev && prev !== poll.token) await serverLogout(apiUrl, prev).catch(() => { /* already dead */ });
      console.log(`\n✓ logged in as ${poll.user.username ?? 'you'} — this login covers all your projects. Try \`trivial projects\`.`);
      return;
    }
  }
  die('sign-in timed out — run `trivial login` again.');
}

/** Plain visible y/N confirmation (line-buffered — no raw mode needed). */
function promptYesNo(question: string): Promise<boolean> {
  process.stderr.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stdin.pause(); stdin.off('data', onData);
        resolve(/^y(es)?$/i.test(buf.slice(0, nl).trim()));
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
}

/**
 * Uninstall = the mirror of install.sh plus credential hygiene:
 *  - user-level logins are revoked server-side (they're per-machine by construction);
 *  - project tokens are removed locally ONLY — the same token may be pasted into CI or
 *    another machine, so revoking it here could break something else. The web UI owns that.
 *  - project folders (and their .trivial/ sync state) are user work — never touched.
 */
async function cmdUninstall(args: Args): Promise<void> {
  const { promises: fsp } = await import('node:fs');
  const self = await fsp.realpath(process.argv[1]).catch(() => process.argv[1]);
  const creds = await listCredentials();
  const userLogins = Object.entries(creds).filter(([k]) => !k.includes('|'));
  const projectTokens = Object.keys(creds).filter((k) => k.includes('|'));

  console.log('uninstall will:');
  for (const [apiUrl] of userLogins) console.log(`  · sign out of ${apiUrl} (revokes this machine's login)`);
  if (projectTokens.length) {
    console.log(`  · remove ${projectTokens.length} project token(s) from this machine — they stay valid elsewhere; revoke in the web UI if unwanted`);
  }
  console.log(`  · remove ${credsDirPath()}`);
  console.log(`  · remove ${self}`);
  console.log('  project folders (and their .trivial/ sync state) are left untouched.');

  if (!args.flags.yes) {
    if (!process.stdin.isTTY) die('not a terminal — re-run with --yes to uninstall non-interactively.');
    if (!(await promptYesNo('continue? [y/N] '))) { console.log('✓ nothing removed.'); return; }
  }

  for (const [apiUrl, token] of userLogins) {
    try {
      await serverLogout(apiUrl, token);
      console.log(`✓ signed out of ${apiUrl}`);
    } catch {
      console.log(`⚠ could not revoke the ${apiUrl} login (offline or already revoked) — check your account's key list.`);
    }
  }
  await removeCredentialsDir();
  try {
    await fsp.unlink(self);
  } catch {
    console.log(`⚠ could not remove ${self} — delete it manually.`);
  }
  console.log('✓ uninstalled. Reinstall any time:  curl -fsSL https://trivial.so/cli/install.sh | sh');
}

/** Open this folder's project in the browser (the app host = the API host minus "api."). */
async function cmdOpen(): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  let ref = state.ref;
  if (!ref) {
    try {
      const proj = await resolveProject(state.apiUrl, token, { id: state.projectId });
      if (proj.owner) { ref = `${proj.owner}/${proj.slug}`; state.ref = ref; await writeState(folder, state); }
    } catch { /* resolution needs membership — fall through */ }
  }
  if (!ref) die('could not resolve this project to an owner/slug URL.');
  const url = `${state.apiUrl.replace('//api.', '//')}/${ref}`;
  console.log(`✓ ${url}`);
  openBrowser(url);
}

// Self-update — fetch the served manifest, compare, atomically replace THIS script.
// The distribution host (trivial.so) is not the API host; override via TRIVIAL_CLI_DIST.
const DIST_BASE = process.env.TRIVIAL_CLI_DIST || 'https://trivial.so/cli';

/** semver-ish compare: a<b → -1, a===b → 0, a>b → 1. Unparseable (e.g. 'dev') sorts oldest. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1;
    const y = Number.isFinite(pb[i]) ? pb[i] : -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function cmdUpdate(args: Args): Promise<void> {
  const manifestRes = await fetch(`${DIST_BASE}/version.json`);
  if (!manifestRes.ok) die(`could not check for updates (HTTP ${manifestRes.status} from ${DIST_BASE}/version.json)`);
  const latest = ((await manifestRes.json()) as { version?: string }).version;
  if (!latest) die('the update manifest is malformed — try again later.');
  if (cmpVersion(VERSION, latest) >= 0 && !args.flags.force) {
    console.log(`✓ already up to date (trivial ${VERSION}).`);
    return;
  }
  const bundleRes = await fetch(`${DIST_BASE}/trivial.js`);
  if (!bundleRes.ok) die(`download failed (HTTP ${bundleRes.status}).`);
  const bundle = await bundleRes.text();
  if (!bundle.startsWith('#!') || bundle.length < 1000) die('downloaded file does not look like the trivial CLI — aborting.');

  const { promises: fsp } = await import('node:fs');
  const self = await fsp.realpath(process.argv[1]);
  const staging = `${self}.update`;
  try {
    await fsp.writeFile(staging, bundle, { encoding: 'utf8', mode: 0o755 });
    await fsp.rename(staging, self); // atomic on POSIX; the running copy is already in memory
  } catch (e) {
    await fsp.rm(staging, { force: true }).catch(() => { /* best-effort */ });
    if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') {
      die(`no write access to ${self} — re-run the installer for that location instead:\n  curl -fsSL ${DIST_BASE}/install.sh | sh`);
    }
    throw e;
  }
  console.log(`✓ updated trivial ${VERSION} → ${latest}  (${self})`);
}

async function cmdWhoami(args: Args): Promise<void> {
  const apiUrl = (args.flags.api as string) || DEFAULT_API;
  const token = await getUserToken(apiUrl);
  if (!token) die('not logged in — run `trivial login`. (Per-project tokens, if any, still work inside their folders.)');
  const { user } = await whoami(apiUrl, token!);
  console.log(`✓ ${user.username ?? user.id}  (${apiUrl})`);
}

async function cmdLogout(args: Args): Promise<void> {
  const apiUrl = (args.flags.api as string) || DEFAULT_API;
  const token = await getUserToken(apiUrl);
  if (!token) { console.log('✓ already logged out.'); return; }
  try { await serverLogout(apiUrl, token!); } catch { /* revoke is best-effort — always forget locally */ }
  await deleteUserToken(apiUrl);
  console.log('✓ logged out — the credential was revoked and removed from this machine.');
}

async function cmdProjects(args: Args): Promise<void> {
  const apiUrl = (args.flags.api as string) || DEFAULT_API;
  const token = await getUserToken(apiUrl);
  if (!token) die('not logged in — run `trivial login` first.');
  const projects = await listProjects(apiUrl, token!);
  if (!projects.length) { console.log('no projects yet — make one at trivial.so, then `trivial clone <owner>/<slug>`.'); return; }
  const refWidth = Math.max(...projects.map((p) => `${p.owner ?? '?'}/${p.slug}`.length));
  for (const p of projects) {
    console.log(`  ${`${p.owner ?? '?'}/${p.slug}`.padEnd(refWidth)}  ${p.role.padEnd(6)}  ${p.name}`);
  }
}

async function cmdPull(args: Args): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  const out = await pullRemote(folder, state, token, Boolean(args.flags.force));
  if (out.kind === 'incomplete') die(incompleteText(out));
  if (out.kind === 'conflict') {
    die(`${out.files.length} file(s) changed on both sides — resolve, or re-run with --force to take the cloud:\n  ${out.files.join('\n  ')}\n  (--force discards your version of these — including deleting any the cloud no longer has)`);
  }
  console.log(out.count ? `✓ pulled ${out.count} change(s)  (@ ${short(out.head)})` : `✓ already up to date  (@ ${short(out.head)})`);
}

async function cmdPush(args: Args): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  const out = await pushLocal(folder, state, token, (args.flags.message as string) || 'push from CLI');
  switch (out.kind) {
    case 'nothing': console.log('✓ nothing to push.'); return;
    case 'pushed': console.log(`✓ pushed ${out.writes} write(s), ${out.deletes} delete(s) → ${short(out.commit)}`); return;
    case 'conflict': die('the cloud moved since your last sync — run `trivial pull` first, then push again.');
    case 'invalid': die(`rejected (invalid): ${out.reason}`);
    case 'forbidden': die(`rejected (forbidden): ${out.message}`);
    case 'over_quota': die('rejected: over quota.');
    case 'error': die(`push failed (HTTP ${out.status}).`);
  }
}

// ── proposals ── the RECEIVING half. `propose` could send and nothing could receive, so a
// contributor's change was a dead end unless the maker opened a browser.

/** Resolve a possibly-partial id to exactly one proposal, so nobody types `alice/fix-the-header`. */
function matchProposal(all: Proposal[], ref: string): Proposal {
  const exact = all.find((p) => p.id === ref);
  if (exact) return exact;
  const hits = all.filter((p) => p.id.includes(ref));
  if (hits.length === 1) return hits[0];
  if (!hits.length) die(`no proposal matching "${ref}".  (list them with \`trivial proposals\`)`);
  die(`"${ref}" matches ${hits.length} proposals:\n  ${hits.map((p) => p.id).join('\n  ')}`);
}

/** "2h ago" — a timestamp is not what you want when scanning a list. */
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60); if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function cmdProposals(): Promise<void> {
  const { state, token } = await loadContext(process.cwd());
  const all = await listProposals(state.apiUrl, state.projectId, token);
  if (!all.length) { console.log('no proposals — nothing waiting for you.'); return; }
  console.log(`${all.length} proposal(s) for ${state.ref ?? state.projectId}\n`);
  for (const p of all) {
    console.log(`  ${p.id}`);
    console.log(`    ${p.subject || '(no message)'}`);
    console.log(`    ${p.author} · ${ago(p.createdAt)}`);
  }
  console.log('\n  trivial review <id>    read it');
  console.log('  trivial accept <id>    apply it to Draft');
}

async function cmdReview(args: Args): Promise<void> {
  const { state, token } = await loadContext(process.cwd());
  const ref = args.positional[0];
  if (!ref) die('usage: trivial review <id>   (list them with `trivial proposals`)');
  const p = matchProposal(await listProposals(state.apiUrl, state.projectId, token), ref);
  const diff = await proposalDiff(state.apiUrl, state.projectId, token, p.id);

  console.log(`${p.id}\n  ${p.subject || '(no message)'}\n  ${p.author} · ${ago(p.createdAt)}\n`);
  const colour = process.stdout.isTTY && !process.env.NO_COLOR;
  for (const f of diff.files) {
    const marker = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : 'M';
    // a binary blob has no line diff — say what it is instead of noise.
    if (f.binary) {
      console.log(`${marker} ${f.path}  binary file${typeof f.bytes === 'number' ? ` (${f.bytes} bytes)` : ''}`);
      console.log('');
      continue;
    }
    const lines = diffLines(f.before ?? '', f.after ?? '');
    const { added, removed } = countChanges(lines);
    console.log(`${marker} ${f.path}  +${added} −${removed}`);
    const body = renderDiff(lines, { colour });
    if (body) console.log(body);
    console.log('');
  }
  console.log(`  trivial accept ${p.id}`);
}

async function cmdAccept(args: Args): Promise<void> {
  const { state, token } = await loadContext(process.cwd());
  const ref = args.positional[0];
  if (!ref) die('usage: trivial accept <id>   (list them with `trivial proposals`)');
  const p = matchProposal(await listProposals(state.apiUrl, state.projectId, token), ref);
  const out = await acceptProposal(state.apiUrl, state.projectId, token, p.id);
  switch (out.kind) {
    case 'accepted':
      console.log(`✓ accepted ${p.id} — ${out.applied} file(s) applied to Draft.`);
      // The folder is now BEHIND, and the next `push` would look like a conflict for no visible
      // reason. Say so here rather than letting them find out.
      console.log('  your folder is now behind — run `trivial pull` to get the change locally.');
      return;
    case 'conflict':
      // Not a failure to hide: someone edited the same lines, and the server is explicit that this
      // one is not resolvable on-surface.
      die(`${p.id} conflicts with Draft in ${out.files.length} file(s):\n  ${out.files.join('\n  ')}\n`
        + `  ${out.hint || 'pull it on your laptop and rebase.'}`);
    case 'invalid':
      die(`${p.id} was refused by validation: ${JSON.stringify(out.errors).slice(0, 300)}`);
    case 'error':
      if (out.status === 403) die('you do not have edit access on this project — only someone who can build can accept.');
      die(`accept failed: ${out.message}`);
  }
}

async function cmdReject(args: Args): Promise<void> {
  const { state, token } = await loadContext(process.cwd());
  const ref = args.positional[0];
  if (!ref) die('usage: trivial reject <id>');
  const p = matchProposal(await listProposals(state.apiUrl, state.projectId, token), ref);
  // Rejecting DELETES the branch — someone else's work, unrecoverably. Confirm unless told not to,
  // the same posture `uninstall` takes about credentials.
  if (!args.flags.yes) {
    console.log(`reject ${p.id} — "${p.subject || '(no message)'}" by ${p.author}`);
    console.log('  this deletes their proposal. It cannot be undone from here.');
    if (!process.stdin.isTTY) die('not a terminal — re-run with --yes to reject non-interactively.');
    if (!(await promptYesNo('continue? [y/N] '))) { console.log('✓ kept.'); return; }
  }
  await rejectProposal(state.apiUrl, state.projectId, token, p.id);
  console.log(`✓ rejected ${p.id}.`);
}

async function cmdStatus(): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  const current = await hashTree(folder);
  const { writes, deletes, skipped, withheld } = diffLocal(current, state.files);
  let ahead = 0;
  try { ahead = (await getChanges(state.apiUrl, state.projectId, token, state.baseSha)).files.length; } catch { /* offline */ }
  console.log(`project ${state.ref ?? state.projectId}`);
  console.log(`base    ${short(state.baseSha)}`);
  console.log(`local   ${writes.length} changed, ${deletes.length} deleted`);
  // never-uploadable paths present locally. Named here because `status`
  // is where a maker asks "what is and isn't in the cloud?".
  if (withheld.length) console.log(`        (+${withheld.length} kept local, never storable: ${withheld.join(', ')})`);
  if (skipped.length) console.log(`        (+${skipped.length} platform-managed, never pushed: ${skipped.join(', ')})`);
  console.log(`cloud   ${ahead ? `${ahead} change(s) to pull` : 'up to date'}`);
  // Draft vs Live. Folder↔Draft can be perfectly in sync while nothing you have done
  // is actually live — the state you most want to know about before walking away. Best-effort: the
  // three lines above are the ones that must survive being offline.
  try {
    const site = (await resolveProject(state.apiUrl, token, { id: state.projectId })).site;
    if (!site) console.log('live    not published yet');
    else if (site.hasUnpublishedChanges) console.log('live    Draft is AHEAD of Live — run `trivial publish`');
    else if (site.publishedAt) console.log(`live    up to date  (${site.url})`);
    else console.log('live    not published yet');
  } catch { /* offline — the local answer is still the useful one */ }
}

/** Resolve the site this folder publishes, with the refusals a maker can act on. */
async function siteForFolder(state: { apiUrl: string; projectId: string }, token: string) {
  const project = await resolveProject(state.apiUrl, token, { id: state.projectId });
  if (!project.site) {
    die('this project has no web app yet — open it in the workshop once to create one, then try again.');
  }
  return project.site!;
}

// ── build ── make a pushed change visible, without shipping it.
async function cmdBuild(): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  const site = await siteForFolder(state, token);
  console.log(`building ${site.handle}…`);
  const out = await buildPreview(state.apiUrl, site.id, token);
  // 's lesson, which the web UI already learned: this endpoint does NOT throw on a failed build,
  // it returns a status. Treating anything non-'built' as success would report a green build over a
  // broken one.
  if (out.status !== 'built' && out.status !== 'completed') {
    die(`${out.errorSummary || out.message || `build did not complete (status: ${out.status}).`}`);
  }
  console.log(`✓ built${out.previewUrl ? `  → ${out.previewUrl}` : ''}`);
}

// ── publish ── the last mile. The conversion action was browser-only until now.
async function cmdPublish(args: Args): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  const site = await siteForFolder(state, token);

  // Unpushed local edits would publish the OLD Draft — silently, and the maker would be looking at
  // their own newer files while reading a success line. Refuse, and say the command that fixes it.
  const { writes, deletes } = diffLocal(await hashTree(folder), state.files);
  if ((writes.length || deletes.length) && !args.flags.force) {
    die(`${writes.length} changed, ${deletes.length} deleted locally — these are NOT in Draft yet, so publishing now would ship the previous version.\n`
      + '  run `trivial push` first, or re-run with --force to publish Draft as it stands.');
  }

  for (const w of await publishPreflight(state.apiUrl, site.id, token)) {
    console.log(`  ${w.severity === 'warn' ? '⚠' : 'ℹ'} ${w.message}`);
  }

  let lastLine = '';
  const out = await publishSite(state.apiUrl, site.id, token, {
    versionLabel: (args.flags.message as string) || undefined,
    onProgress: (p) => {
      const line = p.state === 'queued' && p.queuedAhead ? `queued — ${p.queuedAhead} ahead…` : `${p.state}…`;
      if (line !== lastLine) { console.log(`  ${line}`); lastLine = line; }
    },
  });

  // The DATA half, before the outcome — a widened table or a manifest that failed to apply is the
  // more important of the two things on screen, and it rides on successes as well as failures.
  if (out.manifestWarning) console.log(`\n⚠ ${out.manifestWarning}\n`);

  if (out.status === 'up-to-date') { console.log('✓ already up to date — nothing new to publish.'); return; }
  if (out.status !== 'published') die(out.message || `publish did not complete (status: ${out.status}).`);
  console.log(`✓ live at ${site.url}`);
}

// ── sync ── the always-on loop: each tick pull remote, then push local. Pauses (warns, never
// clobbers) when a file changed on BOTH sides — you resolve locally. Poll-based for cross-platform
// robustness; latency ≈ the interval. Ctrl+C stops.
async function cmdSync(args: Args): Promise<void> {
  const folder = process.cwd();
  const { state, token } = await loadContext(folder);
  const interval = Math.max(1, Number(args.flags.interval) || 2) * 1000;
  console.log(`syncing ${state.projectId} every ${interval / 1000}s — Ctrl+C to stop`);
  // Stop BETWEEN ticks, not mid-operation. `process.exit` inside the handler aborts whatever fs
  // work is in flight, and Ctrl+C is the documented way to stop `sync` — sampled against a state
  // write every interval. Combined with the atomic writeState (config.ts) this makes an interrupted
  // sync unable to leave a truncated or stale state.json.
  let stopping = false;
  process.on('SIGINT', () => { if (stopping) process.exit(0); stopping = true; console.log('\n✓ sync stopping…'); });
  let warnedConflict = '';
  let warnedIncomplete = '';
  let warnedIncompleteAt = 0;
  for (;;) {
    if (stopping) { console.log('✓ sync stopped.'); return; }
    try {
      const pulled = await pullRemote(folder, state, token, false);
      if (pulled.kind === 'conflict') {
        const key = pulled.files.join(',');
        if (key !== warnedConflict) {
          console.log(`⚠ ${pulled.files.length} file(s) changed on both sides — sync paused for them. Resolve locally (edit to match, or 'trivial pull --force'):\n  ${pulled.files.join('\n  ')}`);
          warnedConflict = key;
        }
      } else {
        warnedConflict = '';
        if (pulled.kind === 'incomplete') {
          // warn, but KEEP PUSHING. An incomplete pull is per-path; stopping the push half
          // would silently strand every later local edit, which is the wedge this issue is about.
          // A stale baseSha is safe here — the server answers 409 and the next tick resolves it.
          // Re-emit on a slow beat rather than exactly once, so a wedged daemon stays visible.
          const key = `${pulled.reason}|${pulled.details.join(',')}`;
          const now = Date.now();
          if (key !== warnedIncomplete || now - warnedIncompleteAt > 300_000) {
            console.log(`⚠ ${incompleteText(pulled)}`);
            warnedIncomplete = key;
            warnedIncompleteAt = now;
          }
        } else {
          warnedIncomplete = '';
          if (pulled.count) console.log(`↓ pulled ${pulled.count} change(s)  (@ ${short(pulled.head)})`);
        }
        const pushed = await pushLocal(folder, state, token, 'sync from laptop');
        if (pushed.kind === 'pushed') console.log(`↑ pushed ${pushed.writes} write(s), ${pushed.deletes} delete(s) → ${short(pushed.commit)}`);
        else if (pushed.kind === 'invalid') console.log(`⚠ push rejected (invalid): ${pushed.reason}`);
        else if (pushed.kind === 'forbidden') console.log(`⚠ push rejected: ${pushed.message}`);
        else if (pushed.kind === 'over_quota') console.log('⚠ push rejected: over quota');
        // 'conflict' (cloud moved between this tick's pull and push) resolves on the next tick.
      }
    } catch (e) {
      console.log(`⚠ ${e instanceof HttpError ? `HTTP ${e.status}` : (e as Error).message}`);
    }
    await sleep(interval);
  }
}

const HELP = `trivial ${VERSION} — the terminal loop: clone, run, ship

  trivial login                        sign in via browser — one login, all your projects
  trivial create <name> | --here       a NEW project, scaffolded (needs an empty folder)
  trivial init [--name <name>] [--yes] adopt THIS folder — bring code you already have
  trivial clone <owner>/<slug> [dir]   clone a project you're a member of (also takes a URL or id)
                                       clone/create bring the git history too; --no-git for a
                                       plain snapshot (and it is the automatic fallback)
  trivial pull [--force]               apply cloud changes
  trivial push [-m "message"]          send local changes
  trivial propose [-m "message"]       send local changes for REVIEW
  trivial proposals                    incoming proposals waiting for you
  trivial review <id>                  read one, as a diff
  trivial accept <id>                  apply it to Draft
  trivial reject <id> [--yes]          drop it (deletes their proposal)
  trivial sync [--interval <sec>]      continuous two-way sync
  trivial build                        build Draft — make a pushed change visible
  trivial publish [-m "label"]         publish Draft → Live, and print the URL
  trivial dev [--port N] [--as <user>] run the app locally, with its data
  trivial status                       local diff + cloud-ahead + Draft-vs-Live
  trivial open                         open this project in the browser
  trivial projects                     list your projects
  trivial whoami                       who this machine is signed in as
  trivial logout                       revoke + forget this machine's login
  trivial update [--force]             update to the latest release
  trivial uninstall [--yes]            sign out + remove credentials and the CLI itself
  trivial version                      print the installed version

  git remote (so no token ever goes in a URL):
  git config --global credential.https://git.trivial.so.helper '!trivial git-credential'
  git remote add trivial https://git.trivial.so/<owner>/<slug>
  git push trivial main                # main = the project's source branch

  agents / CI (per-project tokens minted in the web UI — least privilege):
  trivial clone --project <id> --token trv_... [dir]
  trivial login --token trv_...        inside a cloned folder: save that project's token`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.cmd) {
      case 'create': return await cmdCreate(args);
      case 'init': return await cmdInit(args);
      case 'git-credential': return await cmdGitCredential(args);
      case 'clone': return await cmdClone(args);
      case 'login': return await cmdLogin(args);
      case 'pull': return await cmdPull(args);
      case 'push': return await cmdPush(args);
      case 'propose': return await cmdPropose(args);
      case 'proposals': return await cmdProposals();
      case 'review': return await cmdReview(args);
      case 'accept': return await cmdAccept(args);
      case 'reject': return await cmdReject(args);
      case 'sync': return await cmdSync(args);
      case 'dev': return await cmdDev(args);
      case 'build': return await cmdBuild();
      case 'publish': return await cmdPublish(args);
      case 'status': return await cmdStatus();
      case 'projects': return await cmdProjects(args);
      case 'whoami': return await cmdWhoami(args);
      case 'logout': return await cmdLogout(args);
      case 'open': return await cmdOpen();
      case 'update': return await cmdUpdate(args);
      case 'uninstall': return await cmdUninstall(args);
      case 'version': case '--version': case '-v': console.log(`trivial ${VERSION}`); return;
      case 'help': case '--help': case '-h': console.log(HELP); return;
      default: die(`unknown command '${args.cmd}'.\n\n${HELP}`);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) die('unauthorized — the credential is invalid or revoked. Run `trivial login` again.');
      if (err.status === 403) die('forbidden — this token lacks access to the project.');
      if (err.status === 404) die('project not found.');
      die(err.message);
    }
    die((err as Error).message);
  }
}

main();
