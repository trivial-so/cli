// Local git plumbing — used by `trivial init` (adopt this folder, ).
//
// WHY GIT AND NOT THE WRITE-SET. The CLI's own transport (`push`/`pull`) posts a JSON write-set to
// the API, and that endpoint carries a `MAX_FILES = 1000` sanity cap plus the ~7 MB body ceiling.
// Those are properties of the TRANSPORT, not of the platform: the git remote's nginx vhost accepts
// `client_max_body_size 512m` and has no file-count cap at all. Adoption is exactly the case where
// a real repo blows past the write-set's limits, so it rides git. `propose` still needs the
// write-set (a viewer cannot `git push` — `hasBuildAccess` gates the ref), so the two transports
// stay complementary; only the IMPORT path consolidates.
import { execFile } from 'node:child_process';

export interface GitResult { code: number; out: string; }

/** Run git, capturing both streams. Never throws on a non-zero exit — the caller decides. */
export function git(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      // A push must never stop on an interactive prompt inside our own flow: with no terminal git
      // would hang forever waiting for a username. Fail fast instead and let the caller explain.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) as number : 0, out });
    });
  });
}

/**
 * The credential helper `trivial clone` hands git for ONE invocation, and then persists into the
 * clone's LOCAL config.
 *
 * Same string `trivial init` writes (`src/index.ts`), and it exists for one reason:
 * the token never lands in `.git/config`, in `git remote -v`, in shell history or in
 * a screenshot. Scoped by HOST — `credential.<gitBase>.helper` — so it is never consulted for
 * GitHub or anyone else.
 *
 * It resolves `trivial` on PATH, which is what `install.sh` arranges (and warns about when it
 * cannot). If PATH does not have it, the clone fails to authenticate and the caller falls back to
 * the change feed, which needs no git at all — a degraded clone, never a failed one.
 */
export const CREDENTIAL_HELPER = '!trivial git-credential';

/** Shell-quote one argument for the `!`-form helper, which git runs through `sh -c`. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The same helper, but pointing at THIS process rather than at PATH.
 *
 * `install.sh` drops the CLI in `$HOME/.local/bin`, which is not always on PATH — and a clone
 * authenticates through the helper by default, so a PATH miss is total: git reports
 * `trivial: not found`, the clone 401s, and the folder arrives with no history.
 *
 * Invoking `<node> <script> git-credential` rather than the script alone covers both shapes the CLI
 * runs in — the installed shebang file and a bare `node dist/trivial.cjs`.
 */
export function selfCredentialHelper(): string | null {
  const script = process.argv[1];
  if (!script || !process.execPath) return null;
  return `!${shq(process.execPath)} ${shq(script)} git-credential`;
}

/**
 * Clone a project's git remote into `dir`, wiring the credential helper for this invocation AND for
 * the folder afterwards, so the maker's own `git pull` / `git push` work there without the one-time
 * global config step the docs describe.
 *
 * `--origin trivial` rather than the default `origin`: it is the name the maker docs use
 * (`git push trivial`), the name `trivial init` gives the remote it adds, and the name the CLI
 * looks for when deciding whether a folder already has a git route to Trivial. One vocabulary.
 *
 * Never throws — a non-zero exit is an answer (the project may have no repo yet, git may be too
 * old, the network may be down), and every one of them means "fall back to the feed".
 */
export async function cloneRepo(
  gitBase: string, url: string, dir: string, opts: { timeoutMs?: number } = {},
): Promise<GitResult> {
  const scoped = `credential.${gitBase}.helper`;
  // BOTH forms, in this order. `credential.<url>.helper` is multi-valued: git tries each in turn and
  // stops at the first that answers, so the portable PATH form leads and the self-referential one
  // catches the maker whose PATH does not have us. Repeated `-c` accumulates the same way.
  const helpers = [CREDENTIAL_HELPER, selfCredentialHelper()].filter((h): h is string => Boolean(h));
  const cfgArgs = helpers.flatMap((h) => ['-c', `${scoped}=${h}`]);
  const r = await git(process.cwd(), [
    ...cfgArgs,
    'clone', '--origin', 'trivial', '--quiet', url, dir,
  ], { timeoutMs: opts.timeoutMs ?? 600_000 });
  if (r.code !== 0) return r;
  // Persist both, so the maker's own `git pull` / `git push` in this folder authenticate too. The
  // PATH form is what survives a node upgrade or a CLI reinstall; the absolute one is the backstop
  // until PATH is fixed. Best-effort — a clone that worked is still a clone if this does not.
  for (const h of helpers) await git(dir, ['config', '--add', scoped, h]);
  return r;
}

export async function gitAvailable(cwd: string): Promise<boolean> {
  return (await git(cwd, ['--version'])).code === 0;
}

/** Is `cwd` inside a git work tree? (`--is-inside-work-tree` prints "true" and exits 0.) */
export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.out.trim() === 'true';
}

/** The repo root, so adoption can refuse to run from a SUBDIRECTORY of a repo — adopting `src/`
 *  while git would push the whole tree is the kind of surprise that costs someone their quota. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out ? r.out.trim() : null;
}

/** HEAD's full sha, or null when the repo has no commits yet. */
export async function headSha(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', 'HEAD']);
  return r.code === 0 && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null;
}

/** Uncommitted tracked changes or untracked files. Adoption pushes COMMITTED work, so this is
 *  what tells the developer why the project may not match what they see on disk. */
export async function isDirty(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['status', '--porcelain']);
  return r.code === 0 && r.out.length > 0;
}

/** Paths git tracks at HEAD, '/'-joined. This is exactly what a push delivers, so it is what the
 *  local baseline must be built from — see cmdInit. */
export async function trackedFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD']);
  if (r.code !== 0) return [];
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Tracked paths whose WORKING COPY differs from HEAD. Adoption pushes HEAD, so these are exactly
 *  the paths for which the cloud's bytes and the folder's bytes disagree the moment the project is
 *  created — they must stay out of the baseline or the difference becomes invisible forever. */
export async function modifiedAgainstHead(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', 'HEAD']);
  if (r.code !== 0) return [];
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Total size of the pack a full push would send. `count-objects -vH` reports the on-disk object
 *  store; `size-pack` is the packed total, which is the honest proxy for "how big is this repo". */
export async function packedSizeKb(cwd: string): Promise<number | null> {
  const r = await git(cwd, ['count-objects', '-v']);
  if (r.code !== 0) return null;
  const m = /^size-pack: (\d+)$/m.exec(r.out);
  const loose = /^size: (\d+)$/m.exec(r.out);
  if (!m && !loose) return null;
  return Number(m?.[1] ?? 0) + Number(loose?.[1] ?? 0);
}

export async function remoteUrl(cwd: string, name: string): Promise<string | null> {
  const r = await git(cwd, ['remote', 'get-url', name]);
  return r.code === 0 && r.out ? r.out.trim() : null;
}

/**
 * The branch the REMOTE has checked out — never assume.
 *
 * Project repos are created by a bare `git init` with no `-b`, and `init.defaultBranch` is unset on
 * the server, so every one of them is on **`master`**. A developer's repo in 2026 is on `main`.
 * Pushing `main` to a server sitting on `master` creates a SECOND branch: `receive.denyCurrentBranch
 * =updateInstead` and the `push-to-checkout` hook only reconcile a push that targets the CHECKED-OUT
 * branch, so the push reports `[new branch] main -> main`, the working tree is never touched, and
 * nothing downstream — install, preview build, publish — ever sees the commit. Green push, empty
 * project. Verified against a faithful replica of the server config; verified.
 *
 * `ls-remote --symref` asks the remote what HEAD points at, which is the only answer that can't drift.
 */
export async function remoteHeadBranch(cwd: string, url: string): Promise<string | null> {
  const r = await git(cwd, ['ls-remote', '--symref', url, 'HEAD'], { timeoutMs: 60_000 });
  if (r.code !== 0) return null;
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(r.out);
  return m ? m[1] : null;
}
