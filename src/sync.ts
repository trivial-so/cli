// Content-hash sync — no local git required. The base-SHA is the CLOUD's commit,
// so the CLI tracks its own baseline (state.files) and diffs the folder against it.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, dirname } from 'node:path';

// Not synced — mirrors what the server's git tree already excludes.
const IGNORE = new Set(['.git', '.trivial', 'node_modules', 'dist', 'build']);

/** True for a path hashTree cannot see, at any depth. The pull writes whatever the cloud sends,
 *  including paths inside this set (a project may commit `build/`), but must NOT baseline them:
 *  `current` can never contain them, so `diffLocal` would report every one as a local DELETE and
 *  the next push would try to delete a system-owned path. */
export function isIgnoredPath(rel: string): boolean {
  return rel.split('/').some((seg) => IGNORE.has(seg));
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Walk the folder → { relPath: sha256 }, skipping the ignore set. Paths are '/'-joined. */
export async function hashTree(folder: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out[relative(folder, abs).split(sep).join('/')] = sha256(await fs.readFile(abs));
    }
  }
  await walk(folder);
  return out;
}

/**
 * Files the PLATFORM owns and the write path refuses (the platform's own implementation). The install
 * runner is the sole legitimate writer to the lockfiles; `.npmrc` / `pnpm-workspace.yaml` carry the
 * supply-chain floor; `.trivialrc.json` is the scaffold's ownership manifest.
 *
 * They are partitioned out because `pnpm-lock.yaml` ships IN the clone and any `pnpm install`
 * rewrites it: the write-set is validate-all-then-write-all, so one denied path would reject the
 * WHOLE set — a legitimate source edit bundled with a touched lockfile would never land.
 *
 * The CLI is not the authority here; the server refuses these on its own. Skipped paths are always
 * REPORTED, never silently dropped.
 */
const PLATFORM_MANAGED = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', '.npmrc', 'pnpm-workspace.yaml', '.trivialrc.json',
]);

/** True for a path the platform manages and the write path will refuse. Matches at any depth, as
 *  the server's patterns do (`(^|/)<name>$`). */
export function isPlatformManaged(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  return PLATFORM_MANAGED.has(base);
}

/**
 * NEVER UPLOAD. The server force-merges `.env`, `.env.*` and `*.log`
 * into every repo's .gitignore (`REQUIRED_IGNORES`, space-git.ts) and never
 * removes them, so a file matching these can be WRITTEN to the server but can
 * never be COMMITTED. It therefore never enters the change feed and is
 * invisible to every `trivial pull`, `trivial clone` and `git clone` — the
 * maker cannot discover or remove it through any git-backed surface.
 *
 * Uploading one is not merely untidy, it is a live secret-disclosure path:
 * the build's cwd IS the source dir (`--mount source=${sourceDir},target=/work`
 * with `-w /work`), which is exactly where Vite's default `envDir` looks. Any
 * `VITE_`-prefixed value is then INLINED into the client bundle at build time
 * and served publicly, in every retained version.
 *
 * `*.local` is included because the scaffold's own .gitignore carries it and
 * it matches `.env.local` / `.env.production.local` — Vite's documented
 * convention for exactly the values you least want shipped.
 *
 * Partitioned, not refused: the server's write path still ACCEPTS these (they
 * are user-owned dotfiles) and a push is all-or-nothing, so refusing here would
 * fail the whole set over a file the maker never meant to send.
 */
export function isNeverUploadable(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.local') || base.endsWith('.log');
}

export interface LocalDiff { writes: string[]; deletes: string[]; skipped: string[]; withheld: string[]; }

/** current (hashed tree) vs baseline (state.files) → paths to push / delete, with
 *  platform-managed paths partitioned out of both (they can never be accepted) and
 *  never-uploadable paths withheld (they would be accepted but never committed —
 *; see isNeverUploadable). Both are REPORTED, never silently dropped.
 *
 *  A withheld path ALREADY in the baseline is the exception: deleting it is a real
 *  write the server accepts and the maker wants, so deletes of already-tracked
 *  paths are NOT withheld. */
export function diffLocal(current: Record<string, string>, baseline: Record<string, string>): LocalDiff {
  const writes: string[] = [];
  const deletes: string[] = [];
  const skipped: string[] = [];
  const withheld: string[] = [];
  for (const [p, h] of Object.entries(current)) {
    if (baseline[p] === h) continue;
    if (isPlatformManaged(p)) { skipped.push(p); continue; }
    if (isNeverUploadable(p)) { withheld.push(p); continue; }
    writes.push(p);
  }
  for (const p of Object.keys(baseline)) {
    if (p in current) continue;
    // deletes: platform-managed can never be accepted; never-uploadable CAN be
    // deleted (that is the escape hatch for anything an older CLI uploaded).
    (isPlatformManaged(p) ? skipped : deletes).push(p);
  }
  return { writes, deletes, skipped, withheld };
}

/** git's own binary heuristic: a NUL byte in the first 8000 bytes. Kept
 *  byte-identical to the server's copy so the two ends of the wire
 *  never disagree about a file's nature. */
export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Decode a wire file to the exact local bytes: base64 → raw Buffer,
 *  plain string → utf8. The caller hashes THESE bytes for the baseline, so
 *  state.files always matches what hashTree reads back from disk. */
export function decodeWireContent(content: string, encoding?: string): Buffer {
  return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
}

export async function writeLocalFile(folder: string, rel: string, content: Buffer | string): Promise<void> {
  const abs = join(folder, rel);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

export async function deleteLocalFile(folder: string, rel: string): Promise<void> {
  await fs.rm(join(folder, rel), { force: true });
}

/** Raw bytes — the ONLY way to read a file for the wire: reading utf8
 *  destroys binary content before anything can decide how to send it. */
export async function readLocalBytes(folder: string, rel: string): Promise<Buffer> {
  return fs.readFile(join(folder, rel));
}
