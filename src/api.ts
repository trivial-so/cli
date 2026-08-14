// The folder-path endpoints. Zero-dep — Node's global fetch.
// `encoding: 'base64'` marks binary content on the wire in BOTH directions —
// a JSON string cannot carry raw bytes; text files stay plain strings.
export interface ChangeFile { path: string; status: string; content?: string; encoding?: 'base64'; oldPath?: string; }
/**
 * The change feed's control flags are OPTIONAL on the wire, deliberately.
 *
 * `getChanges` is a bare `res.json() as Promise<ChangesResponse>` with no runtime validation, so
 * against an older API — or any response that omits them — these are `undefined` at runtime while
 * TypeScript would insist they are `boolean`. Declaring them required is what makes `!rebuilt` look
 * like a safe positive signal when it is really "the field was absent". Read them ONLY through
 * truthiness; never `=== false`, never `!flag` as evidence of anything.
 */
export interface ChangesResponse {
  head: string | null;
  rebuilt?: boolean;
  truncated?: boolean;
  /** the last path in this page. Present only with `truncated`; ask for the next page with
   *  `after=<cursor>`. Absent from an older API, which is why `truncated` alone still means refuse. */
  cursor?: string;
  /** Total files in the whole change set, stable across pages (the diff is a pure function of
   *  since..HEAD), so progress can be honest rather than an unbounded spinner. */
  total?: number;
  files: ChangeFile[];
}
export interface WriteSetFile { path: string; content?: string; encoding?: 'base64'; op?: 'delete'; }

export class HttpError extends Error {
  constructor(public status: number, public body: string) { super(`HTTP ${status}: ${body}`); }
}

function authHeaders(token: string, json = false): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

/** GET the change feed — what changed on the cloud since `since` (null = full snapshot). */
export async function getChanges(
  apiUrl: string, projectId: string, token: string, since: string | null, after?: string | null,
): Promise<ChangesResponse> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (after) params.set('after', after);
  const q = params.toString() ? `?${params}` : '';
  const res = await fetch(`${apiUrl}/api/projects/${projectId}/changes${q}`, { headers: authHeaders(token) });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<ChangesResponse>;
}

/** POST the write-set (the push). Returns the raw status + parsed body so the caller maps
 *  409/422/403/413 to guidance (a non-2xx is a normal protocol outcome here, not a throw). */
export async function pushWriteSet(
  apiUrl: string, projectId: string, token: string,
  baseSha: string | null, message: string, files: WriteSetFile[],
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${apiUrl}/api/projects/${projectId}/write-set`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ baseSha, message, files }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ── device-auth login — `trivial login` without a pasted token ──
export interface DeviceStart {
  deviceCode: string; userCode: string; verificationUri: string;
  verificationUriComplete: string; expiresIn: number; interval: number;
}
export type DevicePoll =
  | { status: 'pending' }
  | { status: 'approved'; token: string; user: { username: string | null } };

export async function startDeviceLogin(apiUrl: string, label: string): Promise<DeviceStart> {
  const res = await fetch(`${apiUrl}/api/cli/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<DeviceStart>;
}

/** One poll tick. 404 = the code expired unapproved — surfaced as HttpError for the caller. */
export async function pollDeviceLogin(apiUrl: string, deviceCode: string, userCode: string): Promise<DevicePoll> {
  const res = await fetch(`${apiUrl}/api/cli/session/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode, userCode }),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<DevicePoll>;
}

/** The site a project publishes. `null` when the project has never had one. */
export interface CliSite {
  id: string;
  handle: string;
  /** The public origin, named by the SERVER — it knows SITES_DOMAIN and any custom domain. */
  url: string;
  status: string;
  /** Draft is ahead of Live — the same test the workshop's indicator makes. */
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
}

export interface CliProject {
  id: string; owner: string | null; slug: string; name: string; role: string;
  /** Present on `resolveProject`; absent from the list payload, which stays cheap. */
  site?: CliSite | null;
}

export async function whoami(apiUrl: string, token: string): Promise<{ user: { id: string; username: string | null; name: string | null } }> {
  const res = await fetch(`${apiUrl}/api/cli/whoami`, { headers: authHeaders(token) });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<{ user: { id: string; username: string | null; name: string | null } }>;
}

export async function serverLogout(apiUrl: string, token: string): Promise<void> {
  const res = await fetch(`${apiUrl}/api/cli/logout`, { method: 'POST', headers: authHeaders(token) });
  if (!res.ok) throw new HttpError(res.status, await res.text());
}

export async function listProjects(apiUrl: string, token: string): Promise<CliProject[]> {
  const res = await fetch(`${apiUrl}/api/cli/projects`, { headers: authHeaders(token) });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const body = await res.json() as { projects: CliProject[] };
  return body.projects;
}

/** Resolve a clone ref — `owner/slug` or a bare project id — to the project (member-only). */
export async function resolveProject(apiUrl: string, token: string, ref: { owner: string; slug: string } | { id: string }): Promise<CliProject> {
  const q = 'id' in ref
    ? `id=${encodeURIComponent(ref.id)}`
    : `owner=${encodeURIComponent(ref.owner)}&slug=${encodeURIComponent(ref.slug)}`;
  const res = await fetch(`${apiUrl}/api/cli/project?${q}`, { headers: authHeaders(token) });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<CliProject>;
}

/**
 * Create a NEW Trivial project — the server side of `trivial create` (and of `trivial init`,
 * which creates with `scaffold: 'none'` and then pushes the developer's own tree in).
 *
 * `POST /api/sites` is `checkJwtOrPat`, so a `cli:user` token has always reached it. This scaffolds
 * a Trivial project (same provenance, same vite-react shape as one made in the browser) and is
 * emphatically NOT foreign-repo import:  invariant #2 holds because nothing of the maker's
 * goes up — the tree comes DOWN from a scaffold we generated.
 */
export async function createProject(
  apiUrl: string,
  token: string,
  opts: { title?: string; scaffold?: 'vite-react' | 'none' } = {},
): Promise<{
  id: string; projectId: string; projectSlug: string; handle: string;
}> {
  // `scaffold: 'none'` is what makes `trivial init` (adopt this folder) possible: the project is
  // created with an EMPTY source/, and the developer's own tree is pushed into it over git. Laying
  // the scaffold first and deleting it is not an option — its lockfiles and `.trivialrc.json` are
  // system-path-denied on delete, so the tree would strand half-scaffold/half-app.
  const payload: Record<string, unknown> = {};
  if (opts.title) { payload.title = opts.title; payload.siteName = opts.title; }
  if (opts.scaffold) payload.scaffold = opts.scaffold;
  const res = await fetch(`${apiUrl}/api/sites`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const body = await res.json() as { site: { id: string; project_id: string; project_slug: string; handle: string } };
  const s = body.site;
  return { id: s.id, projectId: s.project_id, projectSlug: s.project_slug, handle: s.handle };
}

/**
 * Rename a project (slug + display name).
 *
 * `init` needs this because project creation always allocates an `untitled-N` slug — deliberately,
 * since the browser's flow is "make a draft now, name it when it's something". A maker who typed
 * `trivial create my-app` has already named it, and landing them in `untitled-30` would throw that
 * away and put the wrong thing in their URL. Best-effort at the call site: a taken slug is a real
 * possibility and is not worth failing a successful creation over.
 */
export async function renameProject(apiUrl: string, projectId: string, token: string, slug: string, name: string): Promise<{ slug: string } | null> {
  const res = await fetch(`${apiUrl}/api/projects/${projectId}`, {
    method: 'PATCH', headers: authHeaders(token, true), body: JSON.stringify({ slug, name }),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as { project?: { slug?: string } } | null;
  return { slug: body?.project?.slug ?? slug };
}

// ── Build + Publish ────────────────────────────────────────────────────────────────────────────
// Both endpoints are `checkJwtOrPat`, so a `cli:user` token has always reached them; what was
// missing was the siteId, which `resolveProject` now carries.

/** Advisory completeness checks the workshop shows before shipping. Never blocking — warn, don't stop. */
export async function publishPreflight(apiUrl: string, siteId: string, token: string): Promise<Array<{ code: string; severity: string; message: string }>> {
  const res = await fetch(`${apiUrl}/api/sites/${siteId}/publish-preflight`, { headers: authHeaders(token) });
  if (!res.ok) return []; // advisory by definition — a preflight that errors must not block a publish
  const body = await res.json() as { warnings?: Array<{ code: string; severity: string; message: string }> };
  return body.warnings ?? [];
}

export interface PublishOutcome {
  status: string;                 // 'published' | 'up-to-date' | 'error' | 'empty'
  message: string;
  /** The DATA half of the result: a widened table, a schema change skipped, a manifest that
   *  failed to apply. Orthogonal to `status` — it rides on successes too. */
  manifestWarning?: string;
}

/**
 * Publish, and wait.
 *
 * The POST answers **202 + a job id** and the work happens off the request path, so the
 * honest CLI shape is fire → poll → report. `?wait=1` exists, but polling is what lets us show queue
 * position instead of an opaque hang, and it cannot time out into a lie about a job that is still
 * running. `onProgress` is how the caller renders that.
 */
export async function publishSite(
  apiUrl: string, siteId: string, token: string,
  opts: { versionLabel?: string; onProgress?: (p: { state: string; queuedAhead?: number }) => void } = {},
): Promise<PublishOutcome> {
  const res = await fetch(`${apiUrl}/api/sites/${siteId}/publish`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.versionLabel ? { versionLabel: opts.versionLabel } : {}),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const body = await res.json() as PublishOutcome & { publishId?: string; queuedAhead?: number; pollAfterMs?: number };
  if (!body.publishId) return body;                       // synchronous answer (flag off)

  opts.onProgress?.({ state: 'queued', queuedAhead: body.queuedAhead });
  let delay = body.pollAfterMs || 2000;
  for (;;) {
    await new Promise((r) => setTimeout(r, delay));
    const p = await fetch(`${apiUrl}/api/publishes/${body.publishId}`, { headers: authHeaders(token) });
    if (!p.ok) throw new HttpError(p.status, await p.text());
    const job = await p.json() as {
      state: string; result?: PublishOutcome; error?: { error?: string }; httpStatus?: number;
      queuedAhead?: number; pollAfterMs?: number;
    };
    if (job.state === 'completed') return job.result ?? { status: 'error', message: 'Publish finished with no result.' };
    if (job.state === 'error') throw new HttpError(job.httpStatus ?? 500, job.error?.error ?? 'Publish failed');
    opts.onProgress?.({ state: job.state, queuedAhead: job.queuedAhead });
    delay = job.pollAfterMs || 2000;
  }
}

/** Build a Draft preview — what makes a pushed change visible without publishing it. */
export async function buildPreview(apiUrl: string, siteId: string, token: string): Promise<{ status: string; message: string; previewUrl?: string; errorSummary?: string }> {
  const res = await fetch(`${apiUrl}/api/sites/${siteId}/build-preview`, {
    method: 'POST', headers: { ...authHeaders(token), 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<{ status: string; message: string; previewUrl?: string; errorSummary?: string }>;
}

// ── Proposals, the RECEIVING half ────────────────────────────────────────
// `propose` could send and nothing could receive, so a contributor's change was a dead end unless
// the maker opened a browser. All four endpoints are `checkJwtOrPat` and were reachable the whole
// time — the CLI just had no verbs. Behind VISUAL_PR_ENABLED server-side (404 when off).

export interface Proposal { id: string; headSha: string; author: string; createdAt: string; subject: string; }

export interface ProposalDiff {
  base: string;
  head: string;
  files: Array<{ path: string; status: string; before: string | null; after: string | null; binary?: true; bytes?: number }>;
}

export async function listProposals(apiUrl: string, projectId: string, token: string): Promise<Proposal[]> {
  const res = await fetch(`${apiUrl}/api/projects/${projectId}/proposals`, { headers: authHeaders(token) });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return ((await res.json()) as { proposals: Proposal[] }).proposals;
}

/** The id carries a slash (`<author>/<name>`), which is why it rides in the query string. */
export async function proposalDiff(apiUrl: string, projectId: string, token: string, id: string): Promise<ProposalDiff> {
  const res = await fetch(`${apiUrl}/api/projects/${projectId}/proposals/diff?id=${encodeURIComponent(id)}`, { headers: authHeaders(token) });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<ProposalDiff>;
}

/** Non-2xx is a normal outcome here: 409 is a REAL text conflict, which is information, not a fault. */
export async function acceptProposal(apiUrl: string, projectId: string, token: string, id: string): Promise<
  | { kind: 'accepted'; applied: number }
  | { kind: 'conflict'; files: string[]; hint: string }
  | { kind: 'invalid'; errors: unknown[] }
  | { kind: 'error'; status: number; message: string }
> {
  const res = await fetch(`${apiUrl}/api/projects/${projectId}/proposals/accept`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ id }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.ok) return { kind: 'accepted', applied: Number(body.applied ?? 0) };
  if (res.status === 409) return { kind: 'conflict', files: (body.files as string[]) ?? [], hint: String(body.hint ?? '') };
  if (res.status === 422) return { kind: 'invalid', errors: (body.errors as unknown[]) ?? [] };
  return { kind: 'error', status: res.status, message: String(body.error ?? `HTTP ${res.status}`) };
}

export async function rejectProposal(apiUrl: string, projectId: string, token: string, id: string): Promise<boolean> {
  const res = await fetch(`${apiUrl}/api/projects/${projectId}/proposals/reject`, {
    method: 'POST', headers: authHeaders(token, true), body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return true;
}

/** POST a PROPOSAL. Unlike the write-set this never lands on main — the server commits the
 *  files onto `refs/proposals/<you>/<name>` for the maker to review, so a `project:read` token is enough
 *  and there is no baseSha/conflict question. Non-2xx is a normal outcome here, same as pushWriteSet. */
export async function createProposal(
  apiUrl: string, projectId: string, token: string,
  message: string, files: Array<{ path: string; content: string | null; encoding?: 'base64' }>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${apiUrl}/api/projects/${projectId}/proposals`, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({ message, files }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
