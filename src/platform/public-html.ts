/**
 * The one comment-stripping policy for bytes that leave the building.
 *
 * A 2026-08-07 audit found five independent HTML emitters running three
 * different comment policies between them, and one of them defeated its own
 * stripper: it handled `<!-- -->` while the leak was a `//` comment inside a
 * `<script>`.
 *
 * So: one function, one policy, used by every emitter, with a build check that
 * fails if anything slips.
 *
 * OPT-OUTS, matching the conventions minifiers already use:
 *   `<!--! … -->`  `/*! … *\/`  `//! …`   →  preserved (legal banners)
 *   `<!--[if … ]>` → preserved (an IE conditional is control flow, not text)
 *
 * WHY JS IS SCANNED, NOT REGEXED. `s.replace(/\/\/.*$/gm, '')` looks right and
 * silently corrupts `"https://trivial.so"`, `` `a${b}//c` ``, and `/[/]/`. The
 * scanner below tracks string, template-literal, and regex-literal state, so a
 * slash is only a comment when it is actually a comment. Every one of those
 * cases is in the test file; do not replace this with a regex.
 */

type Kind = 'html' | 'css' | 'js';

/** True when the `/` at `i` starts a regex literal rather than division. */
function regexAllowedBefore(src: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    // After a value, `/` is division. After an operator/punctuator, it opens a regex.
    if (/[)\]}A-Za-z0-9_$'"`]/.test(c)) {
      // `}` is ambiguous (block end vs object literal end) and `)` likewise; treating
      // them as "value" is the conservative choice — we would keep a comment rather
      // than eat code. Keeping a comment is caught by the guard; eating code is not.
      return false;
    }
    return true;
  }
  return true;
}

/**
 * Strip comments from JavaScript source without touching strings, template
 * literals, or regex literals. Preserves `/*!` and `//!` banners.
 */
export function stripJsComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // ---- line comment
    if (c === '/' && next === '/') {
      if (src[i + 2] === '!') { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; out += src.slice(i, end); i = end; continue; }
      const e = src.indexOf('\n', i);
      i = e === -1 ? n : e; // leave the newline for the next iteration
      continue;
    }
    // ---- block comment
    if (c === '/' && next === '*') {
      if (src[i + 2] === '!') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; out += src.slice(i, end); i = end; continue; }
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    // ---- string literal
    if (c === '"' || c === "'") {
      const quote = c; out += c; i++;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\') { i++; if (i < n) out += src[i]; i++; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // ---- template literal (with nested ${ } that may itself contain anything)
    if (c === '`') {
      out += c; i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { out += src[i]; i++; if (i < n) { out += src[i]; i++; } continue; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; out += '${'; i += 2; continue; }
        if (depth > 0 && src[i] === '}') { depth--; out += '}'; i++; continue; }
        if (depth === 0 && src[i] === '`') { out += '`'; i++; break; }
        out += src[i]; i++;
      }
      continue;
    }
    // ---- regex literal
    if (c === '/' && regexAllowedBefore(src, i)) {
      let j = i + 1; let inClass = false; let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                 // unterminated — not a regex after all
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) { while (j < n && /[a-z]/.test(src[j])) j++; out += src.slice(i, j); i = j; continue; }
    }
    out += c; i++;
  }
  return out;
}

/**
 * Strip CSS comments, preserving `/*!` banners.
 *
 * String-aware, because `url("http://x/*y")` is legal CSS and a naive scanner
 * eats the rest of the stylesheet from that point. Caught by the test file, not
 * by review — which is the argument for the test file.
 */
export function stripCssComments(src: string): string {
  let out = ''; let i = 0;
  while (i < src.length) {
    // A quoted value: copy it verbatim, comment delimiters and all.
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]; out += src[i]; i++;
      while (i < src.length) {
        out += src[i];
        if (src[i] === '\\') { i++; if (i < src.length) out += src[i]; i++; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      if (src[i + 2] === '!') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? src.length : e + 2; out += src.slice(i, end); i = end; continue; }
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? src.length : e + 2;
      continue;
    }
    out += src[i]; i++;
  }
  return out;
}

/**
 * Strip comments from an HTML document: `<!-- -->` in markup, CSS comments inside
 * `<style>`, and JS comments inside `<script>`. The last is the one that matters —
 * it is the case a naive HTML stripper misses, and the case that actually leaked.
 */
export function stripHtmlComments(src: string): string {
  // 1. Comments inside <script> and <style>, handled with their own grammar.
  let out = src.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open: string, body: string, close: string) => {
      // A <script type="application/json"> or similar is data, not code — leave it.
      if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template)/i.test(open)) return `${open}${body}${close}`;
      return `${open}${stripJsComments(body)}${close}`;
    },
  );
  out = out.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open: string, body: string, close: string) => `${open}${stripCssComments(body)}${close}`,
  );
  // 2. Markup comments. `<!--!` is the keep-marker; `<!--[if` is control flow.
  out = out.replace(/<!--(?!\[if)(?!!)[\s\S]*?-->[ \t]*\n?/g, '');
  return out;
}

export function stripPublicComments(src: string, kind: Kind): string {
  if (kind === 'js') return stripJsComments(src);
  if (kind === 'css') return stripCssComments(src);
  return stripHtmlComments(src);
}
