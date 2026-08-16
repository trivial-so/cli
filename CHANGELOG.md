# trivial CLI changelog

User-facing changes to the `trivial` CLI. Any change in behaviour bumps the version and adds an
entry here: the version is baked into the bundle at build time (`trivial --version`), so this file
is how a reported version maps back to what it does.

## 0.21.0 — 2026-08-16

- **A push can bring files back, and now it does.** Pushing does not only send your files: the
  server can write its own into the same commit — declaring a data model regenerates the typed row
  module beside the manifest, and the checkpoint sweeps it in. `push` used to jump its baseline
  straight to that commit, which asserts the commit equals what was sent. It doesn't, so the
  server's file ended up on the far side of a cursor already past it: `pull` answered *"already up
  to date"* forever and the file never arrived. Nothing complained, because stale generated types
  still compile.

  `push` now keeps its pre-push baseline and reconciles from it. Anything the server generated
  lands in your folder and is named:

  ```
  ✓ pushed 1 write(s), 0 delete(s) → 7b2e338
    ↓ and received 1 file(s) the server generated: src/lib/trivial-tables.ts
  ```

  It costs one extra round trip per push. If that read-back fails the baseline stays where it was,
  on purpose — the next push then says "pull first", which you can recover from, where advancing
  would bury the server's write, which you cannot.

## 0.20.1 — 2026-08-15

- **`trivial init` could not adopt a folder unless `trivial` was on your PATH.** Adoption pushes
  with the credential helper it has just configured, and it configured only the PATH form — so
  running it through `npx` produced `trivial: not found`, a 401, and a half-adopted project:
  created on the server, remote wired, nothing in it. It now passes both helper forms to its own
  push, the way `clone` already did.
- **Nothing writes an npx cache path into your repository any more.** `npx` unpacks into
  `~/.npm/_npx/<hash>/…`, a directory keyed to one resolution and collected like any cache. `clone`
  persisted that absolute path into `.git/config` as a helper, so a folder authenticated fine until
  the cache was pruned and then failed with a 401 — which reads as losing access to the project
  rather than as the CLI having moved. Only the durable PATH form is written down now, and
  `clone`/`create`/`init` say plainly that npx leaves nothing on your PATH.
- `trivial update` and `trivial uninstall` no longer tell an npx user to run `npm update -g` on a
  package they never installed. There is nothing to update; the credential is still worth revoking,
  so they name `trivial logout`.
- `trivial help install` leads with installing, and says what npx is for.

## 0.20.0 — 2026-08-15

- **`trivial` with no command is now a situation, not a manual.** It reads the folder you are
  standing in and answers where you are and what to do next — a first run gets a greeting and one
  step (`trivial login`); a project folder gets its name, its local diff and the verb that matters
  right now. It makes no network call, so it is instant and it works offline; anything cloud-shaped
  stays in `trivial status`, which was asked a question and is allowed to be slow.
- **`trivial help` is the reference, grouped by the arc** — start, the loop, ship, review, this
  machine. The git-remote and agent-token blocks moved to `trivial help git` and
  `trivial help agents`, with `trivial help install` for npm, npx, sudo-free prefixes and
  provenance. Previously all of it was one 45-line screen printed at a bare `trivial`, which
  overflowed a standard terminal: what scrolled away was `trivial login`, and what stayed on screen
  was the credential-helper block.
- **A typo gets one line and a suggestion**, not the whole reference: `trivial puhs` answers
  "Did you mean `push`?". Transpositions and abbreviations both resolve (`stat` -> `status`).
- **A folder cloned with plain git is recognised as one.** It carries no `.trivial/state.json`, so
  the greeting used to call it "not a project folder" while the maker was plainly standing in one.
  It now names the project from the git remote and says which verbs apply.
- **`trivial clone` ends with next steps**, the way `create` and `init` already did — it is the
  command the docs lead with, and it was the one that stopped at a bare success line.
- `trivial login` caches your display name locally so the greeting can use it without asking the
  server. `trivial logout` forgets it.

## 0.19.0 — 2026-08-14

- **npm owns updates for npm installs.** `trivial update` overwrites its own file, which is right
  for the standalone installer and wrong for a package npm manages. Both `update` and `uninstall`
  now detect an npm install and name the command that owns the job (`npm update -g @trivial-so/cli`,
  `npm uninstall -g @trivial-so/cli`). `trivial logout` remains the right first step before removal.
- `trivial help` leads with the npm install.

## 0.18.4 — 2026-08-14

- First release published from CI over OIDC, carrying a **provenance attestation**:
  `npm audit signatures` verifies the package was built from this repository.

## 0.18.3 — 2026-08-14

- **Published to npm as `@trivial-so/cli`.** The CLI's source moved to its own public repository.
- The runtime install states its size and destination before downloading.
- `trivial login` leads with the plain URL and a typed code; the prefilled link is offered second.
- The local runtime installs with `--ignore-scripts`, so an install on your machine never runs a
  third-party lifecycle script.
- `clone` and `create` bring the project's git history when git is available, with the credential
  helper wired for that folder. The file-sync path remains the fallback.

## 0.17.1 — 2026-08-06 (…and now it actually does)

0.17.0 below claimed local sign-in worked. It did not. That release shipped the
server half — the page really is served — but nothing on the page ran, so every
click was a no-op and the entry above it was wrong. This is the other half.

- **The sign-in page's script had never parsed.** It is written inside a template
  literal in `dev.ts`, which ate the backslashes out of `/\+/g` and `/\//g` and
  shipped `/+/g` — `Invalid regular expression: Nothing to repeat`. That kills the
  whole `<script>` at parse time, so none of the buttons were ever wired. The
  base64url conversion no longer uses a regex at all, so there is nothing left to
  eat. A non-ASCII id now reports why it cannot be used instead of doing nothing.
- **The session it stored destroyed itself.** The page wrote `{access_token}` with
  no `expires_at`, and the scaffold's `getToken` tests `Date.now < expires_at -
  30_000`, which is NaN-false when the field is absent. With no refresh token it
  fell through to `clearTokens`, so every call returned null *and deleted both
  stored keys*. The page now writes the `expires_at` the contract requires.
- **The token named the wrong claim.** Its payload said `userId`; the scaffold's
  `userFromToken` requires `sub`, so `getUser` returned null even when a token
  survived. It now mints `sub`. Tokens in the older spelling are still accepted, so
  a tab left open across `trivial update` is not signed out.
- **`signIn` reaches the local page.** It used to throw "Sign-in is not enabled
  for this project yet" whenever no user pool was provisioned, which is the state of
  every project before its first publish — so it threw before it could ever navigate.
  It now proceeds on a loopback origin, where `trivial dev` serves that page itself.
  Published origins are unchanged and still get the explanatory error.

Two things found in the same page while fixing it, neither reachable before (nothing
could run, so nothing could redirect), both of which the fix above would have armed:

- **`return_to` could break out of the `<script>`.** It was interpolated with
  `JSON.stringify`, which does not escape `<`, so `?return_to=/</script><img
  src=x onerror=…>` closed the block and ran. `<` is now escaped.
- **`return_to` could leave the origin.** The guard was `startsWith('/') &&
  !startsWith('//')`, which admits `/\evil.com`; every URL parser normalises that to
  `//evil.com`. It is now an actual same-origin check. The page also sends
  `X-Frame-Options: DENY` and `frame-ancestors 'none'`, because the dev server sends
  no CORS headers and this page was the one surface a foreign tab could have driven.

The probe that certified 0.17.0 (`api/e2e/probe-cli-dev-auth.mjs`) forged its own
bearer and sent it with raw `fetch`, so it tested the server against a copy of the
server's own assumptions and could not see any of this. It now executes the page's
real served `<script>` and bundles the real vendored `trivial-auth.ts` to ask whether
a session exists. `PROBE_CLI=<old build>` runs it against a previous binary, which is
how you confirm it still goes red.

## 0.17.0 — 2026-08-05 (sign-in works locally)

- **`trivial dev` serves the sign-in page**, so the scaffold's end-user auth
  finally does what its own file promises: one sign-in button that works in the
  canvas frame, on your laptop, and on Live. Before this, `signIn`
  navigated to `/__trivial/auth/sign-in` — a page the API serves and the dev
  server did not — so it fell through to Vite and silently re-rendered your app.
  Correctly-scoped data, dead button, no error to search for.
- **The local page is a picker, not a password prompt.** It offers the user ids
  your `.trivial/seed.json` actually references, plus any role your manifest
  declares, plus a free-text box. Choosing one scopes every `/api/data/*` and
  `/api/<name>` call exactly as `--as` does — and exactly as a real signed-in
  user will once you publish.
- **No change to your project's `trivial-auth.ts`.** That file is vendored, so a
  scaffold-side fix would only have reached new projects. Serving the page the
  existing contract already navigates to fixes projects cloned months ago,
  untouched.

## 0.16.1 — 2026-08-05

- **A folder holding only `.git` is called a repository, not "a codebase"**. Small, but it was the first thing a developer saw and it was not
  true. The hand-over to `trivial init` is unchanged.

## 0.16.0 — 2026-08-05 (big projects sync again)

- **The change feed is paged, so project size no longer decides whether the CLI
  works**. The server caps a response by BYTES rather than only by file
  count — the old file cap guarded the wrong resource, and two live projects hold
  280 MB across just 172 files, far under it. `trivial clone` of a 96 MB project
  went from "would assemble a ~374 MB JSON body on one API worker" to 3 seconds,
  47/47 files byte-identical, with the worker's memory *lower* afterwards.
- **Pages are assembled before anything is applied**, and a project that changes
  mid-walk restarts rather than stitching together a tree that never existed. If
  it keeps changing, the pull refuses and says so instead of looping.
- **An abandoned clone leaves nothing behind.** Both clone forms write their sync
  state before pulling, so a refusal used to leave a half-initialised folder — a
  project directory with an id and no files — while the message claimed the
  folder was untouched. It now cleans up, and the message is true.

## 0.15.0 — 2026-08-05 (pull stops lying)

- **`trivial pull` reads the change feed's control flags.** `rebuilt` and
  `truncated` were declared on the wire type for four releases and never
  consulted, which is one omission and several silent-data-loss bugs.
  Every failure mode here was a success message printed over a wrong tree.
- **A truncated feed is now refused, not applied.** The server slices at 2000
  changed files; the feed has no cursor, so re-asking returns the same page.
  Applying the slice and advancing the sync point made the rest permanently
  unreachable — a 2500-file clone landed 2000, printed `✓ cloned 2000 files`,
  and lost 500 with no signal. The refusal names the git remote, which has no cap.
- **A file the cloud deleted is now deleted locally.** On a full re-sync the
  server sends the whole tree as `added`, so a deleted file is merely *absent* —
  it used to survive on disk forever, and editing it re-pushed it to the cloud.
  Only paths the CLI watched arrive from the cloud are pruned; a locally-edited
  one becomes a conflict instead. `--force` now deletes as well as overwrites,
  and says so.
- **A rename no longer leaves a ghost.** The feed carries `oldPath`; the old file
  was never removed, stayed in the baseline with a matching hash, and so
  `trivial status` reported "in sync" while the folder diverged — and a stale
  source file kept getting built and published.
- **Agreement is no longer a conflict.** A file whose incoming bytes already
  match disk has converged. Previously any path appearing on both sides
  collided, so after any `git push trivial` a `pull` refused wholesale and
  `trivial sync` wedged silently and permanently. This is what makes the git
  remote and the CLI usable in one folder — which is the shape `trivial init`
  creates.
- **A transient server error no longer wipes your sync point.** A failed lookup
  returns `head: null`, which used to null the baseline and promote every later
  pull to a full re-sync.
- **Interrupting a sync can no longer corrupt the folder's identity.** The state
  file is written atomically (tmp + rename), and Ctrl+C stops between ticks
  rather than mid-write. An unparseable state file reads as "not a Trivial
  project", so this could lose a folder's project id outright.
- **A committed `build/` path is written but no longer baselined**, and existing
  poisoned baselines are repaired on the next pull — that entry made every push
  attempt a delete of a system-owned path, failing with an opaque 500.
- **`trivial init` on a dirty tree no longer strands your uncommitted work.**
  Adoption pushes HEAD, so the cloud holds the committed bytes — but the baseline
  recorded the *working-tree* hash, which claimed the cloud already had the
  uncommitted edits. `status` reported clean and `push` sent nothing, so that
  work could never reach Trivial. Dirty paths now stay out of the baseline and
  show up as ordinary pending changes. (Shipped in 0.14.0, fixed here.)


## 0.14.0 — 2026-08-05 (create vs. init: the verbs follow developer habit)

- **`trivial init <name>` is now `trivial create <name>`.** Across the CLI corpus
  the split runs the other way from ours: `init` means "adopt the directory I am
  standing in" (git, cargo, `go mod`, terraform, supabase, firebase, npm, pnpm)
  and `new`/`create` means "make me a directory that does not exist yet". Ours
  meant the opposite, and the first thing a developer did with it — type it
  inside their own repo — got a refusal. `create` now scaffolds; `init` is
  reserved for adopting the folder you are in. (.)
- **`trivial init` adopts the folder you are standing in.** It creates a project
  with an empty source tree and pushes your existing repository into it over git.
  Your own remote is untouched — Trivial is added alongside it. Adoption rides
  **git, not the write-set**, deliberately: the write-set's `MAX_FILES = 1000`
  and ~7 MB body ceiling are properties of that transport, while the git vhost
  accepts 512 MB and caps no file count — and a real repository is exactly the
  case that exceeds them. Requires a git repo with at least one commit, run from
  the repository root; prints what it will do and asks before pushing (`--yes`
  to skip). Capability is stated up front rather than discovered: build and
  publish are framework-agnostic, canvas preview works after the first build,
  and click-to-edit plus code round-trip remain scaffold-only.
- **The old forms hard-error for one minor version** rather than being silently
  reinterpreted. `trivial init my-app` under the new meaning would adopt the
  CURRENT folder into a project named "my-app" — a project built from the wrong
  tree. The error names the exact replacement command.
- **`create`'s refusal inside a codebase now hands over** instead of ending the
  conversation. It used to say Trivial "does not import an existing repo"; it now
  points at `trivial init`. This also retires the case where a folder holding only
  `.git` was called "a codebase" and turned away.
- **`.env`, `.env.*`, `*.local` and `*.log` are withheld from pushes and
  proposals** (shipped 2026-08-04 without a version bump — recorded here).
  The server force-merges these into every repo's `.gitignore` and never removes
  them, so such a file could be *written* to the server but never *committed* —
  making it invisible to every `trivial pull`, `trivial clone` and `git clone`.
  It was also a live secret-disclosure path: the build's cwd is the source dir,
  which is exactly where Vite looks for `.env`, so any `VITE_`-prefixed value was
  inlined into the public client bundle. Verified empirically. Withheld paths are
  always REPORTED, never silently dropped, and deleting one that an older CLI
  already uploaded still works — that is the only way to clean it up.

## 0.13.0 — 2026-08-01 (binary files ride proposals too)

- **`trivial propose` carries binary files** — the 0.12.0 loud refusal is
  gone. Binaries travel base64 into the proposal ref (hashed as exact bytes),
  `trivial review` prints `binary file (N bytes)` instead of a line diff, and
  `accept` applies the true bytes through the same binary plane as push. The
  web Changes panel shows the same "Binary file" row.
- **Restoring a checkpoint restores binaries faithfully** (server-side): the
  restore plan tags binary blobs, so a rollback spanning an image no longer
  mangles it.
- **The binary ceiling doubled to ~7 MB** (push and propose) — the folder-path
  body limit now matches the platform's own upload ceiling. Larger files still
  refuse by name.

## 0.12.0 — 2026-08-01 (binary files travel faithfully)

- **Fixed: push/pull/clone corrupted binary files**. The wire is JSON,
  and a PNG read as UTF-8 text arrives permanently mangled — found when the
  docs project's screenshots shipped as 418 KB of noise. Binary files (git's
  heuristic: a NUL byte in the first 8000 bytes) now travel base64 with an
  explicit `encoding` field, in both directions; the server decodes and writes
  through its binary plane. Text files are byte-identical on the wire to
  before — nothing changes for source code.
- **Pull baselines binaries correctly**: the recorded hash is of the decoded
  bytes, so a pulled image doesn't read as locally-changed forever.
- **Oversized binaries are refused by name**: the wire's body cap means a
  binary over ~3.5 MB can't ride the folder path yet; the push says which file
  and points at the web interface, instead of dying as an opaque 413.
- **Proposals refuse binaries loudly** — the proposal plane is text-only for
  now; a binary in the diff names itself rather than mangling into someone's
  review queue.

## 0.11.0 — 2026-07-31 (git credential helper)

- **`trivial git-credential`** — a git credential helper, so a token never goes
  into a remote URL. Configure once:

  ```
  git config --global credential.https://git.trivial.so.helper '!trivial git-credential'
  git remote add trivial https://git.trivial.so/<owner>/<slug>
  ```

  and `git push` authenticates from the credential `trivial login` already stored.
  This is what `gh auth setup-git` and `gcloud` do. It replaces the
  `https://x-access-token:trv_…@…` form the spec used to suggest — a CI idiom that
  writes your token into `.git/config`, `git remote -v`, shell history, and any
  screenshot.

  It stays **silent** for hosts it doesn't serve, so configuring it globally can't
  affect your github.com remotes, and `store`/`erase` are no-ops — the credential's
  lifecycle belongs to `trivial login` / `trivial logout`, not to whether one push
  happened to 401.

## 0.10.0 — 2026-07-31 (proposals: the receiving half)

- **`trivial proposals` · `review <id>` · `accept <id>` · `reject <id> [--yes]`** —
  `propose` could send and nothing could receive, so a contributor's change sat on
  a ref until the maker opened a browser. That is an outbox, not collaboration.
  The four endpoints were `checkJwtOrPat` the whole time; the CLI had no verbs.
- **`review` renders a real line diff**, not a list of filenames — reading someone
  else's change is the entire point of reviewing it. Colour only on a TTY, so
  piping into a pager or a file stays clean.
- **Partial ids resolve** (`trivial accept fix-header` finds `alice/fix-header`),
  and an ambiguous one **refuses rather than guessing** — accepting the wrong
  person's change is not a recoverable mistake.
- **A conflict is reported, with its files.** The server distinguishes a genuine
  text conflict from a failure; flattening that into "accept failed" would throw
  away the only information that tells you what to do next.
- **`accept` tells you your folder is now behind**, because it is, and otherwise
  the next `push` looks like a conflict for no visible reason.
- **`reject` confirms first** — it deletes someone else's work, unrecoverably —
  and refuses to run non-interactively without `--yes`.

## 0.9.0 — 2026-07-31 (trivial init)

- **`trivial init <name>`** — create a NEW project and scaffold it into `./<name>/`,
  ready to `pnpm install && trivial dev`. `--here` uses the current folder instead.
  It **claims the name you typed**: creation always allocates an `untitled-N` slug
  (the browser's flow is "draft now, name it later"), so init renames straight
  after — you asked for `my-app`, you get `my-app`, in the URL too. If that slug is
  taken it says so and keeps the project rather than failing.

  **It refuses to run inside an existing codebase, and says why.** Trivial never
  ingests a foreign repo ( #2 — the build economy is tuned for scaffolded
  trees), so init inside your app would be the import path that rule forbids, and
  would overwrite your files besides. The refusal names the rule instead of
  pretending you mistyped. A merely non-empty folder is refused too, on plain
  overwrite grounds.

## 0.8.0 — 2026-07-31 (the loop closes: build + publish from the terminal)

- **`trivial publish [-m "label"]`** — Draft → Live without a browser, and it prints
  the URL the **server** names (so a custom domain or a non-prod host is correct
  rather than a guessed `<handle>.trivial.build`). Polls the publish job queue, so a
  queued publish reports its position instead of hanging. It **refuses** while you
  have unpushed local edits — publishing then would silently ship the *previous*
  version while you look at newer files; `--force` if you meant it. Surfaces the
  publish's data-layer warning (a widened table, a manifest that failed to apply)
  before the outcome line, because that matters more than "live at".
- **`trivial build`** — build Draft so a pushed change is visible without shipping
  it. Treats any non-`built` status as failure: the endpoint returns a status rather
  than throwing, so reporting success on it would report a green build over a broken
  one.
- **`trivial status` now knows Draft vs Live.** You can be perfectly in sync with
  Draft and still have nothing live — the state you actually want before walking
  away. Best-effort: the local lines still print when you're offline.

Why this needed a server change: both endpoints were always reachable with a
`cli:user` token; the CLI simply had no way to learn a `siteId`, so it could
describe a project and do nothing to it. `GET /api/cli/project` now carries the
site (id, url, status, unpublished-changes).

## 0.5.0 — 2026-07-28 (uninstall)

- **`trivial uninstall [--yes]`** — the mirror of the installer, with credential
  hygiene: shows the plan and confirms, revokes this machine's login(s)
  server-side, removes `~/.trivial`, and removes the CLI binary itself. Project
  folders (and their `.trivial/` sync state) are never touched. Project tokens
  are removed **locally only** — the same token may live in CI or on another
  machine, so server-side revocation of those stays in the web UI.
- Manual equivalent, if the CLI itself is broken:
  `trivial logout; rm -rf ~/.trivial ~/.local/bin/trivial`.

## 0.4.0 — 2026-07-28 (sign-in hardening + DX)

- **The approve page now shows who is asking** before you click Connect — the
  requesting terminal's name, its IP, and how long ago it asked. A code someone
  *sent* you announces itself as someone else's terminal. (Server: new
  session-gated `describe` endpoint; codes reveal nothing to logged-out callers.)
- **`trivial login --token` (no value) keeps the secret out of shell history** —
  reads `$TRIVIAL_TOKEN`, else prompts with input hidden.
- `trivial login` when already signed in says so (`--force` starts a fresh
  sign-in; the replaced key is still revoked).
- **`trivial open`** — open this folder's project in the browser.
- `trivial status` shows `owner/slug` instead of the raw project id (stored at
  clone time).
- An empty clone now explains itself: "no synced history yet — publish once (or
  make an edit in the app), then `trivial pull`".

## 0.3.1 — 2026-07-28

- A **viewer's** `trivial push` now says what's actually going on ("You do not
  have edit access") and points at `trivial propose` — previously the 403 fell
  back to a misleading "protected path or token lacks write access" message.

## 0.3.0 — 2026-07-28 (self-update)

- **`trivial update [--force]`** — checks the served manifest
  (`trivial.so/cli/version.json`, written at every deploy) and atomically
  replaces the installed script in place; `--force` reinstalls regardless.
  Re-running the install one-liner still works and does the same thing.
- **Re-login hygiene:** `trivial login` over an existing login now revokes the
  replaced credential server-side (best-effort) instead of stranding a live key
  in your account's key list.

## 0.2.0 — 2026-07-28 (the login rev, )

- **`trivial login`** with no flags now signs in via the browser (device-auth):
  prints `trivial.so/cli/connect?code=…`, best-effort opens it, polls, and saves a
  **user-level credential** that covers every project you're a member of. Works
  headless — open the URL on any machine.
- **`trivial clone <owner>/<slug> [dir]`** — clone by ref (also accepts a project
  URL or a bare project id); no more per-project token minting for your own work.
- New: **`trivial projects`** (list member projects), **`trivial whoami`**,
  **`trivial logout`** (revokes server-side + forgets locally), **`trivial
  --version`**.
- Credential resolution is **narrow-wins**: a per-project token (the agent/CI
  path, unchanged) still beats the user-level login inside its folder. All
  pre-0.2.0 `--token` invocations work verbatim.
- `trivial login --token trv_…` outside a cloned folder now saves the token as
  the machine's user-level credential (previously it refused to run).

## 0.1.0 — 2026-07-22 (initial)

- The folder-path client: `clone` (per-project token) · `pull` · `push` ·
  `propose` · `sync` · `status`. Content-hash diff sync, conflict-safe pull,
  zero runtime dependencies.
