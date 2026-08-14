/**
 * Build the `trivial` CLI, stripping comments out of the EMBEDDED RUNTIME SOURCE
 * before esbuild ever sees it.
 *
 * A plugin rather than `--minify`: the runtime ships its service-worker code as
 * `String.raw` template literals, so those comments are STRING DATA and no bundler
 * reaches them.
 *
 * dist/trivial.cjs is published at https://trivial.so/cli/trivial.js and installed by
 * `curl -fsSL https://trivial.so/cli/install.sh | sh`, so what ships is read on other
 * people's machines.
 *
 * The comments stay in the repo, where they explain the runtime they sit inside.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { stripJsComments, stripHtmlComments } from '../src/platform/public-html.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

let blocks = 0, removed = 0;

/**
 * Strip comments out of embedded source held in template literals.
 *
 * Three shapes ship code as STRING DATA, so no bundler can reach them:
 *   1. `String.raw`…`` — the canvas-runtime + workerd service-worker sources.
 *      Documented to contain no `${` and no escaped backticks, so the closing
 *      backtick is simply the next one. Asserted below rather than assumed.
 *   2. `SW_TEMPLATE` / `*_SOURCE` plain template literals — same content, ordinary
 *      backticks. Handled by name, not by guesswork, so an HTML or SQL template
 *      never gets fed to a JS comment scanner.
 *   3. HTML pages built as template literals with an inline `<script>` (the CLI's
 *      local-dev sign-in page). `stripHtmlComments` already knows that grammar —
 *      it only descends into <script>/<style> bodies and <!-- --> markup.
 */
/** Index of the backtick closing the template literal that opens at `open`.
 *  Honours \\` escapes and nested `${ … }` (whose contents may hold their own
 *  template literals). Returns -1 if unterminated. */
function matchingBacktick(code, open) {
  let i = open + 1, depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '$' && code[i + 1] === '{') { depth++; i += 2; continue; }
    if (depth > 0 && c === '}') { depth--; i++; continue; }
    if (depth > 0 && c === '`') { const inner = matchingBacktick(code, i); if (inner === -1) return -1; i = inner + 1; continue; }
    if (depth === 0 && c === '`') return i;
    i++;
  }
  return -1;
}

function stripEmbeddedSource(code) {
  // (1) String.raw blocks — unambiguous extent.
  let out = '', i = 0;
  const OPEN = 'String.raw`';
  for (;;) {
    const j = code.indexOf(OPEN, i);
    if (j === -1) { out += code.slice(i); break; }
    const bodyStart = j + OPEN.length;
    const end = code.indexOf('`', bodyStart);
    if (end === -1) { out += code.slice(i); break; }
    const body = code.slice(bodyStart, end);
    if (body.includes('${')) {
      throw new Error('String.raw block contains ${ — the scan assumption broke; fix build.mjs');
    }
    const clean = stripJsComments(body);
    blocks++; removed += body.length - clean.length;
    out += code.slice(i, bodyStart) + clean;
    i = end;
  }
  code = out;

  // (2) Named embedded-source templates (SW_TEMPLATE, *_SOURCE) with ordinary
  //     backticks. Scanned, not regexed: SW_TEMPLATE's body CONTAINS template
  //     literals, so a non-greedy `([\s\S]*?)`` ends at the first inner backtick
  //     and silently leaves the rest unstripped — which is exactly what happened
  //     on the first attempt (2 comments survived).
  // Any `const|let|var … = \`` binding, not just the *_SOURCE naming convention:
  // dev-data-plane-node.ts holds its SW prelude in a plain local called `prelude`,
  // and matching on names alone missed it. A body only gets stripped if it LOOKS
  // like JS source — a line-start `//` plus a JS keyword, and no markup — so an
  // HTML, SQL or prose template is never fed to the JS scanner. That last guard
  // matters: stripJsComments reads `https://x` as a line comment and would eat
  // the rest of the line out of an HTML template.
  //
  // "No markup" is tested by a CLOSING TAG or a known document tag, not by any
  // `<word`. The first version asked for `<[a-z!/]` and a real case walked straight
  // into it: two prose placeholders in PGLITE_CORE_SOURCE's own comments —
  // `/pglite/<name>` and `/api/<route>` — classified 25 KB of service-worker
  // JS as markup, so the whole block skipped stripping and shipped three ADR
  // references to https://trivial.so/cli/trivial.js. A comment describing a
  // path placeholder silently disabled the comment stripper. Real markup always
  // closes something; a placeholder never does.
  const DECL = /(?:const|let|var)\s+\w+(?:\s*:\s*string)?\s*=\s*`/g;
  let acc = '', pos = 0, m2;
  while ((m2 = DECL.exec(code)) !== null) {
    const openIdx = m2.index + m2[0].length - 1;   // the backtick itself
    const close = matchingBacktick(code, openIdx);
    if (close === -1) continue;
    const body = code.slice(openIdx + 1, close);
    const looksLikeMarkup = /<\/[a-z][\w-]*>|<!doctype|<html\b|<head\b|<body\b|<script\b|<style\b|<meta\b|<link\b/i.test(body);
    const looksLikeJs = /^[ \t]*\/\//m.test(body)
      && /\b(?:function|var |const |let |return |=>)/.test(body)
      && !looksLikeMarkup;
    const clean = looksLikeJs ? stripJsComments(body) : body;
    if (clean !== body) { blocks++; removed += body.length - clean.length; }
    acc += code.slice(pos, openIdx + 1) + clean;
    pos = close;
    DECL.lastIndex = close;
  }
  code = acc + code.slice(pos);

  // (3) Inline <script> inside HTML template literals.
  const before = code.length;
  code = stripHtmlComments(code);
  if (code.length !== before) { blocks++; removed += before - code.length; }
  return code;
}

const stripRuntimeComments = {
  name: 'strip-embedded-runtime-comments',
  setup(build) {
    // Every .ts, not just canvas-runtime: WORKER_ENTRY_SOURCE lives under
    // services/workerd-host/ and shipped its ADR references the same way.
    build.onLoad({ filter: /\.ts$/ }, async (args) => ({
      contents: stripEmbeddedSource(await fs.readFile(args.path, 'utf8')),
      loader: 'ts',
    }));
  },
};

/** esbuild labels each bundled module with its path (`__esm({"the platform module)`)
 *  for stack traces. That publishes our repo layout in a file strangers download,
 *  and there is no esbuild option to rename it — so rewrite the labels to their
 *  basename afterwards. Purely cosmetic to the runtime: the label is a property
 *  name, never resolved as a path. */
function anonymizeModuleLabels(code) {
  return code.replace(/"(?:\.\.\/)+[^"]*?([^"/]+\.tsx?)"\(\)\s*\{/g, '"$1"() {');
}

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(ROOT, 'dist/trivial.cjs'),
  banner: { js: '#!/usr/bin/env node' },
  define: { CLI_VERSION: JSON.stringify(version) },
  // esbuild does NOT strip comments unless it is minifying — so ordinary TS
  // comments in bundled code shipped too, alongside its own `// the platform module
  // module banners which advertise the repo layout. Whitespace-minify removes
  // both; identifiers and syntax are left alone so stack traces still name
  // functions and the bundle stays greppable for anyone auditing what they ran.
  minifyWhitespace: true,
  minifyIdentifiers: false,
  minifySyntax: false,
  legalComments: 'none',
  plugins: [stripRuntimeComments],
});
const outfile = path.join(ROOT, 'dist/trivial.cjs');
const built = await fs.readFile(outfile, 'utf8');
await fs.writeFile(outfile, anonymizeModuleLabels(built));
await fs.chmod(outfile, 0o755);
console.log(`[cli] built v${version} — ${blocks} embedded-source block(s) stripped, ${removed} bytes of comments removed`);
