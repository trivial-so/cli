# Trivial CLI

The terminal client for [Trivial](https://trivial.so): clone a project to your machine, run it
locally with its own data, sync changes both ways, and publish.

```sh
npm i -g @trivial-so/cli
trivial login
trivial clone you/field-notes
cd field-notes && pnpm install
trivial dev
```

Needs Node 22 or newer. `npx @trivial-so/cli <command>` works without installing, and every release
is published from CI with a provenance attestation — `npm audit signatures` verifies that what you
installed was built from this repository.

If you would rather not have a global npm package, the standalone installer puts the same single
file on your PATH and updates itself with `trivial update`:

```sh
curl -fsSL https://trivial.so/cli/install.sh | sh
```

## What it does

| | |
|---|---|
| `trivial create <name>` | scaffold a new project into an empty folder |
| `trivial init` | adopt the folder you are standing in — code you already have |
| `trivial clone <owner>/<slug>` | clone a project, with its Git history |
| `trivial pull` / `push` / `sync` | move changes between your folder and the project |
| `trivial propose` / `proposals` / `review` / `accept` | changes for review, for people without write access |
| `trivial dev` | run the app locally, with its data and its handlers |
| `trivial build` / `publish` | build the Draft, put it on the internet |
| `trivial status` / `projects` / `whoami` | where things stand |

## Two transports, on purpose

A folder can talk to Trivial two ways, and they are complementary rather than redundant:

- **The change feed** — `pull`/`push` exchange files over the API and keep their own baseline in
  `.trivial/state.json` (a path→sha256 map). No Git required, which is the point: it works for
  someone who has never used it.
- **Git** — every project has a real remote at `https://git.trivial.so/<owner>/<slug>`. `clone` and
  `create` use it when Git is available, so your folder arrives with history and a wired `trivial`
  remote; `init` requires it, because adopting an existing codebase means pushing real commits.

The CLI's own sync verbs always use the change feed. Git is yours to drive directly — `git pull`,
`git push trivial main`, branches, whatever you like — and the two converge on the same project.

Authentication for Git goes through a credential helper (`trivial git-credential`), so no token is
ever written into `.git/config`, a remote URL, or your shell history.

## Building it yourself

```sh
pnpm install
pnpm test          # builds, then runs the suite against the built bundle
pnpm build         # → dist/trivial.cjs, the single file the installer downloads
```

The tests are black-box: they spawn the built bundle against an in-process mock of the API, so what
is verified is the artifact you would run, not the source it came from.

## `src/platform/`

These modules are maintained in the Trivial platform and vendored here on release — the local data
substrate, the handler runtime, the manifest schema and its RLS generator, and the bundling options
`trivial dev` shares with the server. They live here because `trivial dev` has to execute handlers
and evaluate access rules the *same way* the hosted preview does; a reimplementation would drift,
and "works locally" would stop meaning anything.

Treat them as read-only: edits belong upstream, and a check fails our release if this copy and the
platform's diverge.

## License

MIT — see [LICENSE](./LICENSE).
