// `trivial git-credential` — a git credential helper, so nobody ever pastes a token into a URL.
//
// git's helper protocol is three verbs over stdin/stdout: `get` (answer with username/password),
// `store`, `erase`. Configure it once per host:
//
//   git config --global credential.https://git.trivial.so.helper '!trivial git-credential'
//
// and from then on `git push` authenticates itself from the credential `trivial login` already
// stored. This is what `gh auth setup-git` and `gcloud` do, and it exists because the alternative
// the spec originally proposed — `https://x-access-token:trv_…@git.trivial.so/owner/slug` — writes
// the token into `.git/config` in plaintext, into `git remote -v`, into shell history, and into any
// screenshot. That form is a CI idiom; a person should never have to hold the token at all.
import { getUserToken, listCredentials } from './config.js';

/** Parse git's `key=value` lines (terminated by a blank line or EOF). */
export function parseCredentialInput(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) break;                       // blank line ends the request
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * Which stored login serves this git host?
 *
 * Credentials are keyed by API URL (`https://api.trivial.so`); git asks about a GIT host
 * (`git.trivial.so`). The rule is that both must live under the same parent domain — strip a leading
 * `git.` and any port, then take the first user-level credential whose host is that domain or a
 * subdomain of it. That resolves prod (`git.trivial.so` → `https://api.trivial.so`) and a local
 * mirror (`git.ol.local:3443` → `https://ol.local:3030`) without a hard-coded table.
 *
 * Deliberately conservative: an unmatched host returns null and the helper stays SILENT, which makes
 * git fall through to its next helper or prompt — exactly what should happen for github.com.
 */
export function apiUrlForGitHost(host: string, credentialKeys: string[]): string | null {
  const bare = host.replace(/^git\./, '').replace(/:\d+$/, '').toLowerCase();
  if (!bare) return null;
  for (const key of credentialKeys) {
    if (key.includes('|')) continue;               // per-project keys, not a user login
    let h: string;
    try { h = new URL(key).hostname.toLowerCase(); } catch { continue; }
    if (h === bare || h.endsWith(`.${bare}`)) return key;
  }
  return null;
}

/**
 * Run one helper invocation. `stdout` is only written for `get`, and only on a match.
 *
 * `store` and `erase` are accepted and ignored on purpose: the credential's lifecycle belongs to
 * `trivial login` / `trivial logout`, and a helper that deleted the login because a push 401'd would
 * be a genuinely bad surprise.
 */
export async function runGitCredential(verb: string, stdin: string): Promise<string> {
  if (verb !== 'get') return '';                   // store / erase / anything else — no-op, exit 0
  const input = parseCredentialInput(stdin);
  if (input.protocol && input.protocol !== 'https') return '';
  const host = input.host || '';
  if (!host) return '';

  const apiUrl = apiUrlForGitHost(host, Object.keys(await listCredentials()));
  if (!apiUrl) return '';
  const token = await getUserToken(apiUrl);
  if (!token) return '';

  // The username is ignored server-side (`trvFromBasic` takes whatever follows the first colon), but
  // git requires one, and `x-access-token` is the convention every host uses for "the password is
  // the real credential".
  return `username=x-access-token\npassword=${token}\n`;
}
