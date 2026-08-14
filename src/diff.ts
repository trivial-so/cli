// A unified-diff renderer, written by hand because the CLI has zero runtime deps.
//
// `trivial review` exists so a maker can read someone else's change before applying it, and a list
// of filenames is not reading a change. The server hands back whole before/after blobs (that is what
// the browser's side-by-side needs), so the line-level work happens here.

/** Longest common subsequence over lines — the standard DP, which is fine at the sizes a proposal has. */
function lcs(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

export interface DiffLine { kind: ' ' | '-' | '+'; text: string; }

/** Walk the LCS table into a flat edit script. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.length ? after.replace(/\n$/, '').split('\n') : [];
  const dp = lcs(a, b);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: '-', text: a[i] }); i++; }
    else { out.push({ kind: '+', text: b[j] }); j++; }
  }
  while (i < a.length) out.push({ kind: '-', text: a[i++] });
  while (j < b.length) out.push({ kind: '+', text: b[j++] });
  return out;
}

/** +added / −removed, for a one-line summary. */
export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.kind === '+') added++; else if (l.kind === '-') removed++; }
  return { added, removed };
}

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m';

/**
 * Render with `context` unchanged lines around each hunk.
 *
 * Colour only when stdout is a TTY: piping `trivial review` into a file or a pager is a normal thing
 * to do with a diff, and escape codes in that file are noise.
 */
export function renderDiff(lines: DiffLine[], opts: { context?: number; colour?: boolean } = {}): string {
  const context = opts.context ?? 3;
  const colour = opts.colour ?? false;
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep.add(k);
  });

  const out: string[] = [];
  let gap = false;
  lines.forEach((l, idx) => {
    if (!keep.has(idx)) { gap = true; return; }
    if (gap) { out.push(colour ? `${DIM}   …${RESET}` : '   …'); gap = false; }
    const body = `${l.kind} ${l.text}`;
    if (!colour || l.kind === ' ') out.push(`  ${body}`);
    else out.push(`  ${l.kind === '+' ? GREEN : RED}${body}${RESET}`);
  });
  return out.join('\n');
}
