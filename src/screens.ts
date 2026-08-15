/**
 * The screens someone reads BEFORE they know the commands.
 *
 * Two different jobs, deliberately split:
 *
 *   `trivial`        the SITUATION — where am I, what now. Local-only, instant, one `next:`.
 *   `trivial help`   the REFERENCE — every command, grouped by the arc it belongs to.
 *
 * The split exists because the single screen this replaced tried to be both. It ran 45 lines into a
 * 24-line terminal, so the half that scrolled away was the identity line and `trivial login`, and
 * the half left on screen was the git credential-helper block — reference material, read by a
 * first-time user as a setup requirement.
 *
 * Rules that keep it honest:
 *   - the situation screen NEVER makes a network call. It has to answer instantly and on a plane.
 *     Anything cloud-shaped (ahead-count, Draft-vs-Live, the live URL) belongs to `trivial status`.
 *   - exactly one `next:` per screen, and it moves with the situation.
 *   - two SGR codes only, bold and dim, so it survives a light terminal as well as a dark one.
 */

const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const COLS = process.stdout.columns || 80;
// Below this the description column costs more than it explains, so the commands stand alone.
const TERSE = COLS < 60;

const bold = (s: string): string => (COLOUR ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string): string => (COLOUR ? `\x1b[2m${s}\x1b[0m` : s);

export interface Row { cmd: string; desc: string }

/** Command column + dim description, aligned to a caller-chosen pad so blocks line up together. */
function row(r: Row, pad: number, indent: number): string {
  const gutter = ' '.repeat(indent);
  if (TERSE || !r.desc) return gutter + bold(r.cmd);
  return `${gutter}${bold(r.cmd.padEnd(pad))}  ${dim(r.desc)}`;
}

function padFor(rows: Row[]): number {
  return rows.reduce((n, r) => Math.max(n, r.cmd.length), 0);
}

// ── the situation screen ────────────────────────────────────────────────────────────────────────

export interface Situation {
  version: string;
  /** `~/.trivial` has never existed — this machine just installed the CLI. */
  firstRun: boolean;
  signedIn: boolean;
  username?: string | null;
  /** "owner/slug" (or the id) when standing in a project folder. */
  project?: string | null;
  /** "owner/slug" for a folder that came from `git clone` and so carries no sync state. */
  gitCheckout?: string | null;
  /** The local diff against the last sync. Local-only, so it is always available. */
  local?: { writes: number; deletes: number } | null;
}

function header(s: Situation, who?: string): string {
  const subject = who ?? s.project ?? (s.signedIn && s.username ? `signed in as ${s.username}` : null);
  return `  ${bold(`trivial ${s.version}`)}${subject ? dim(` — ${subject}`) : ''}`;
}

/** `next:` and the rest, padded together so the two blocks read as one column. */
function blocks(next: Row[], rest: Row[]): string[] {
  const pad = padFor([...next, ...rest]);
  const out = ['  next:', ...next.map((r) => row(r, pad, 4))];
  if (rest.length) out.push('', ...rest.map((r) => row(r, pad, 4)));
  return out;
}

export function situationScreen(s: Situation): string {
  const lines: string[] = [];

  if (!s.signedIn) {
    // Nothing works before a credential, so the screen says one thing regardless of where it runs.
    if (s.firstRun) {
      // No wordmark. The product is called `trivial`, and any typographic treatment that respaces
      // or redraws the name makes the first thing a stranger sees a version of it that is not it.
      // The tagline is what this screen has to say; the name is just the name.
      lines.push(header(s), '');
      // Says what the CLI ADDS, which is the only question a terminal client for a browser-based
      // product raises — and it is true for someone who has no projects yet, which "clone -> run ->
      // ship" was not: the first verb in that line is the one a new reader cannot run.
      lines.push('  Your Trivial projects, on your machine.', '');
    } else {
      lines.push(header(s), '');
      lines.push("  This machine isn't signed in.", '');
    }
    lines.push(...blocks(
      [{ cmd: 'trivial login', desc: 'sign in through your browser' }],
      [{ cmd: 'trivial help', desc: 'all commands' }],
    ));
    if (s.firstRun) {
      lines.push('', '  No account yet?  https://trivial.so');
      // The trust beat, shown once, to the person who just typed `npm i -g` and wondered.
      lines.push('', dim('  Zero dependencies, and every release is published from CI with a provenance'));
      lines.push(dim('  attestation — verify this install with `npm audit signatures`.'));
    }
    return lines.join('\n');
  }

  if (s.project) {
    const changed = s.local ? s.local.writes + s.local.deletes : 0;
    lines.push(header(s), '');
    if (s.local) {
      lines.push(changed
        ? `  ${s.local.writes} changed, ${s.local.deletes} deleted since your last push`
        : dim('  no local changes since your last push'));
      lines.push('');
    }
    // The one recommended verb moves with the folder: unsent work first, otherwise go build.
    const push: Row = { cmd: 'trivial push', desc: 'send your changes' };
    const dev: Row = { cmd: 'trivial dev', desc: 'run it locally, with its data' };
    const pull: Row = { cmd: 'trivial pull', desc: 'apply cloud changes' };
    lines.push(...blocks(
      [changed ? push : dev],
      [
        ...(changed ? [dev] : [pull]),
        { cmd: 'trivial status', desc: 'local + cloud + Draft vs Live' },
        { cmd: 'trivial publish', desc: 'Draft -> Live' },
        { cmd: 'trivial help', desc: 'all commands' },
      ],
    ));
    return lines.join('\n');
  }

  if (s.gitCheckout) {
    // Cloned straight from the git remote rather than through the CLI. Everything git does works;
    // the CLI's own verbs read `.trivial/state.json`, which a git clone does not carry. Saying so
    // beats "you're not in a project folder", which is both wrong and unactionable while the
    // maker is plainly standing in one.
    lines.push(header(s, `${s.gitCheckout} (git checkout)`), '');
    lines.push('  Cloned with git, so there is no sync state here: pull, push, build and publish');
    lines.push('  all need one. git is the transport in this folder.', '');
    lines.push(...blocks(
      [{ cmd: 'trivial dev', desc: 'run it locally — needs no sync state' }],
      [
        { cmd: 'git push trivial', desc: 'send commits the way you cloned them' },
        { cmd: 'trivial help git', desc: 'the remote, and the credential helper' },
        { cmd: 'trivial help', desc: 'all commands' },
      ],
    ));
    return lines.join('\n');
  }

  lines.push(header(s), '');
  lines.push("  You're not in a project folder.", '');
  lines.push(...blocks(
    [
      { cmd: 'trivial create <name>', desc: 'new project, scaffolded' },
      { cmd: 'trivial clone <owner>/<slug>', desc: 'bring one down, with its history' },
      { cmd: 'trivial init', desc: 'adopt this folder — code you already have' },
    ],
    [
      { cmd: 'trivial projects', desc: 'list yours' },
      { cmd: 'trivial help', desc: 'all commands' },
    ],
  ));
  return lines.join('\n');
}

// ── the reference ───────────────────────────────────────────────────────────────────────────────

interface Group { title: string; note?: string; items: Row[] }

const GROUPS: Group[] = [
  {
    title: 'start',
    items: [
      { cmd: 'login', desc: 'sign in through your browser' },
      { cmd: 'create <name> | --here', desc: 'a NEW project, scaffolded (empty folder)' },
      { cmd: 'clone <owner>/<slug> [dir]', desc: "a project you're a member of (URL or id too)" },
      { cmd: 'init [--name <name>] [--yes]', desc: 'adopt THIS folder — code you already have' },
    ],
  },
  {
    title: 'the loop',
    items: [
      { cmd: 'status', desc: 'local diff + cloud-ahead + Draft vs Live' },
      { cmd: 'pull [--force]', desc: 'apply cloud changes' },
      { cmd: 'push [-m "message"]', desc: 'send local changes' },
      { cmd: 'sync [--interval <sec>]', desc: 'continuous two-way sync' },
      { cmd: 'dev [--port N] [--as <user>]', desc: 'run the app locally, with its data' },
    ],
  },
  {
    title: 'ship',
    items: [
      { cmd: 'build', desc: 'build Draft — make a pushed change visible' },
      { cmd: 'publish [-m "label"]', desc: 'publish Draft -> Live, and print the URL' },
      { cmd: 'open', desc: 'open this project in the browser' },
    ],
  },
  {
    title: 'review',
    note: 'changes from people without write access',
    items: [
      { cmd: 'propose [-m "message"]', desc: 'send local changes for REVIEW' },
      { cmd: 'proposals', desc: 'incoming proposals waiting for you' },
      { cmd: 'review <id>', desc: 'read one, as a diff' },
      { cmd: 'accept <id>', desc: 'apply it to Draft' },
      { cmd: 'reject <id> [--yes]', desc: 'drop it (deletes their proposal)' },
    ],
  },
  {
    title: 'this machine',
    items: [
      { cmd: 'projects', desc: 'list your projects' },
      { cmd: 'whoami', desc: 'who this machine is signed in as' },
      { cmd: 'logout', desc: "revoke + forget this machine's login" },
      { cmd: 'update [--force]', desc: 'update to the latest release' },
      { cmd: 'uninstall [--yes]', desc: 'sign out, remove credentials and the CLI' },
      { cmd: 'version', desc: 'print the installed version' },
    ],
  },
];

/** Every verb the dispatcher answers to — also the corpus `suggest` searches. */
export const COMMANDS: string[] = GROUPS.flatMap((g) => g.items.map((i) => i.cmd.split(' ')[0]));

const TOPICS: Record<string, string[]> = {
  git: [
    `  ${bold('trivial help git')} ${dim('— using the git remote directly')}`,
    '',
    '  Every project has a real remote:',
    '',
    '    https://git.trivial.so/<owner>/<slug>',
    '',
    '  `clone` and `create` wire it up as "trivial" and bring the history with them, so git',
    '  works the way you expect from the first minute.',
    '',
    '  Set the credential helper once and no token ever lands in a URL, in .git/config, or in',
    '  your shell history:',
    '',
    "    git config --global credential.https://git.trivial.so.helper '!trivial git-credential'",
    '',
    '  Then:',
    '',
    '    git remote add trivial https://git.trivial.so/<owner>/<slug>',
    "    git push trivial main        # main = the project's source branch",
    '',
    "  The CLI's own pull/push use the change feed instead — no git required, which is the",
    '  point. Both converge on the same project.',
  ],
  agents: [
    `  ${bold('trivial help agents')} ${dim('— tokens for agents and CI')}`,
    '',
    '  Per-project tokens are minted in the web UI. One carries a single project, not your',
    '  account — least privilege for something that runs unattended.',
    '',
    '    trivial clone --project <id> --token trv_... [dir]',
    "    trivial login --token trv_...      inside a cloned folder: save that project's token",
    '',
    '  Bare `--token` reads $TRIVIAL_TOKEN, or prompts without echo, so the secret stays out',
    '  of your shell history.',
    '',
    '  Tokens live in ~/.trivial/credentials.json (0600) and never in the project folder, so',
    '  they cannot be committed by accident.',
  ],
  install: [
    `  ${bold('trivial help install')} ${dim('— installing and updating')}`,
    '',
    '    npm i -g @trivial-so/cli          install, and update',
    '',
    "  If that asks for sudo, it is npm's global prefix rather than anything we need. Point it",
    '  somewhere you own, and no install on this machine needs root again:',
    '',
    '    npm config set prefix ~/.local    # then put ~/.local/bin on your PATH',
    '',
    '  Or take the standalone single file, which installs to ~/.local/bin and updates itself:',
    '',
    '    curl -fsSL https://trivial.so/cli/install.sh | sh',
    '    trivial update',
    '',
    '    npx @trivial-so/cli <command>     run one command without installing',
    '',
    '  npx is for trying it. It is not an install: nothing lands on your PATH, so `git push',
    '  trivial` in a folder you cloned has no credential helper to call, and every run fetches',
    '  the package again. Install it before you rely on it.',
    '',
    '  Every release is published from CI with a provenance attestation, binding the tarball',
    '  to the commit it was built from:',
    '',
    '    npm audit signatures',
  ],
};

export function helpText(version: string, topic?: string): string {
  if (topic) {
    const page = TOPICS[topic];
    if (page) return page.join('\n');
    return [
      `  no help topic "${topic}".`,
      '',
      `  topics:  ${Object.keys(TOPICS).join('  ')}`,
    ].join('\n');
  }

  // A different audience from the first-run screen: someone here is already using it and wants the
  // map, which the group headings below give them. The subtitle only has to be an identity.
  const lines: string[] = [`  ${bold(`trivial ${version}`)} ${dim('— the terminal client for Trivial')}`];
  // ONE description column for the whole table. Padding per group is easier and reads worse: the
  // column steps left and right down the page and the eye has to find it again at every heading.
  const pad = padFor(GROUPS.flatMap((g) => g.items));
  for (const g of GROUPS) {
    lines.push('', `  ${bold(g.title)}${g.note ? dim(`  (${g.note})`) : ''}`);
    lines.push(...g.items.map((i) => row(i, pad, 4)));
  }

  const more: Row[] = [
    { cmd: 'trivial help git', desc: 'using the git remote directly' },
    { cmd: 'trivial help agents', desc: 'tokens for agents and CI' },
    { cmd: 'trivial help install', desc: 'installing, updating, npx' },
  ];
  lines.push('', `  ${bold('more')}`, ...more.map((r) => row(r, padFor(more), 4)));
  return lines.join('\n');
}

// ── did you mean ────────────────────────────────────────────────────────────────────────────────

/**
 * Damerau-Levenshtein (optimal string alignment), not plain Levenshtein.
 *
 * The difference is the whole point: a transposition is the commonest typo at a shell prompt, and
 * plain Levenshtein scores `puhs` -> `push` as two edits, which is exactly the threshold at which a
 * short word stops resembling anything. Counting the swap as one edit is what makes the suggestion
 * appear for the mistake people actually make.
 */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The nearest verb, or nothing.
 *
 * A typo deserves one line, not the whole manual: dumping the reference on an unknown command was
 * how a mistyped `puhs` filled the terminal with the git credential-helper block.
 */
export function suggest(input: string): string | null {
  // An abbreviation is not a typo, and edit distance treats it as one: `stat` is two edits from
  // `status` yet obviously means it. A prefix of three or more characters is the stronger signal,
  // so it wins outright; the shortest match breaks a tie (`prop` -> propose, not proposals).
  if (input.length >= 3) {
    const prefixed = COMMANDS.filter((c) => c.startsWith(input.toLowerCase()));
    if (prefixed.length) return prefixed.sort((a, b) => a.length - b.length)[0];
  }

  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of COMMANDS) {
    const d = distance(input.toLowerCase(), c);
    if (d < bestScore) { bestScore = d; best = c; }
  }
  // Two edits on a short word is already a different word.
  const ceiling = input.length <= 4 ? 1 : 2;
  return bestScore <= ceiling ? best : null;
}
