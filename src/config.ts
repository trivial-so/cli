// Local state + credentials. The token lives in HOME (0600), never the project
// folder — so it can't be git-committed by accident (threat-model mitigation).
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface State {
  apiUrl: string;
  projectId: string;
  ref?: string;                        // "owner/slug" when known (clone-by-ref) — for status/open
  baseSha: string | null;              // the cloud HEAD as of the last sync
  files: Record<string, string>;       // path -> sha256, the local tree as of the last sync
  /**
   * The paths the CLOUD is known to hold, as of the last pull.
   *
   * Distinct from `files`, which is the LOCAL tree at the last sync: `files` also holds paths the
   * CLI never sends (`.env`, `*.log`, the platform-managed lockfiles) and paths the server accepted
   * but never committed — its checkpoint is `git add -A`, which honours the project's `.gitignore`.
   *
   * So absence from a full-tree payload does NOT mean the cloud deleted it, and pruning from
   * `files` would delete the maker's own work. Only a path watched ARRIVING from the cloud and then
   * disappearing is provably deleted; that is what this set records.
   *
   * Optional: a folder without provenance skips the prune for one pull and seeds the set from that
   * pull's payload.
   */
  cloud?: string[];
}

export function stateDir(folder: string): string { return join(folder, '.trivial'); }
function statePath(folder: string): string { return join(stateDir(folder), 'state.json'); }

export async function readState(folder: string): Promise<State | null> {
  try { return JSON.parse(await fs.readFile(statePath(folder), 'utf8')) as State; } catch { return null; }
}

/**
 * Write the sync point ATOMICALLY — tmp + rename.
 *
 * A plain `writeFile` is an O_TRUNC write with no fsync, so it is not atomic even with respect to
 * itself: an interruption mid-write leaves a truncated or empty state.json. That matters more than
 * it looks, because `readState` swallows a parse failure and returns null — which every caller
 * reads as "this folder is not a Trivial project". The folder's baseline, its project id and its
 * ref would all be gone, and `trivial init` would happily adopt the directory a second time.
 *
 * `sync` samples this against Ctrl+C every interval, so the window is hit by the documented way to
 * stop the daemon. Rename is atomic on POSIX and, for a same-directory rename, on Windows.
 */
export async function writeState(folder: string, state: State): Promise<void> {
  await fs.mkdir(stateDir(folder), { recursive: true });
  const target = statePath(folder);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, target);
}

// ── credentials — ~/.trivial/credentials.json ──
// Two key shapes in one flat map: `<apiUrl>|<projectId>` = a per-project token (the agent/CI
// least-privilege path), and a bare `<apiUrl>` = the user-level `trivial login` credential.
// Lookup prefers the narrow key, so a deliberately-scoped token wins over the broad login.
function credsDir(): string { return join(homedir(), '.trivial'); }
function credsPath(): string { return join(credsDir(), 'credentials.json'); }
function credKey(apiUrl: string, projectId: string): string { return `${apiUrl}|${projectId}`; }

async function readCreds(): Promise<Record<string, string>> {
  try { return JSON.parse(await fs.readFile(credsPath(), 'utf8')) as Record<string, string>; } catch { return {}; }
}

async function writeCreds(creds: Record<string, string>): Promise<void> {
  await fs.mkdir(credsDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(credsPath(), JSON.stringify(creds, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(credsPath(), 0o600).catch(() => { /* best-effort tighten */ });
}

export async function getToken(apiUrl: string, projectId: string): Promise<string | null> {
  const creds = await readCreds();
  return creds[credKey(apiUrl, projectId)] ?? creds[apiUrl] ?? null;
}

export async function setToken(apiUrl: string, projectId: string, token: string): Promise<void> {
  const creds = await readCreds();
  creds[credKey(apiUrl, projectId)] = token;
  await writeCreds(creds);
}

export async function getUserToken(apiUrl: string): Promise<string | null> {
  return (await readCreds())[apiUrl] ?? null;
}

export async function setUserToken(apiUrl: string, token: string): Promise<void> {
  const creds = await readCreds();
  creds[apiUrl] = token;
  await writeCreds(creds);
}

export async function deleteUserToken(apiUrl: string): Promise<void> {
  const creds = await readCreds();
  if (!(apiUrl in creds)) return;
  delete creds[apiUrl];
  await writeCreds(creds);
}

// ── uninstall support ──
export function credsDirPath(): string { return credsDir(); }

/** Every stored credential — bare-apiUrl keys are user-level logins, `apiUrl|projectId` are project tokens. */
export async function listCredentials(): Promise<Record<string, string>> { return readCreds(); }

export async function removeCredentialsDir(): Promise<void> {
  await fs.rm(credsDir(), { recursive: true, force: true });
}
