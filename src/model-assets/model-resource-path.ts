/** Model bundle names are relative identities, never byte-store filesystem paths.
 * glTF references are URIs; USD asset paths and uploaded names are raw names. */
export class ModelResourcePathError extends Error {
  readonly code = 'MODEL_RESOURCE_PATH_INVALID';
  constructor(message: string) { super(message); this.name = 'ModelResourcePathError'; }
}

const invalid = () => new ModelResourcePathError('Use a relative file path inside the model bundle.');
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const scheme = /^[a-z][a-z0-9+.-]*:/i;
const MAX_PATH_BYTES = 1024;

/** Normalize Unicode consistently for the uploaded manifest and its references.
 * Callers must reject duplicate names after normalization; case is significant. */
export function modelFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_BYTES) throw invalid();
  const path = value.normalize('NFC');
  const encoded = new TextEncoder().encode(path);
  if (encoded.length > MAX_PATH_BYTES || new TextDecoder().decode(encoded) !== path
    || controls.test(path) || path.includes('\\') || path.startsWith('/') || scheme.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) throw invalid();
  return path;
}

/** A file map must remain unambiguous even when a filesystem uses decomposed
 * Unicode. A Map also keeps names such as __proto__ as ordinary data. */
export function modelFileNames(values: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    const path = modelFilePath(value);
    if (names.has(path)) throw new ModelResourcePathError('Two model files have the same relative path.');
    names.add(path);
  }
  return names;
}

/** Resolve a file URI relative to the referring file, allowing ../ within the
 * supplied bundle. Absolute URLs, query/fragment selectors and root escapes are
 * refused. Embedded data is a separate bounded decoder, not a file reference. */
export function modelResourcePath(fromFile: string, uri: unknown): string {
  const from = modelFilePath(fromFile);
  if (typeof uri !== 'string' || !uri || uri.length > MAX_PATH_BYTES * 3
    || controls.test(uri) || uri.includes('\\') || uri.startsWith('/') || scheme.test(uri)
    || uri.includes('?') || uri.includes('#')) throw invalid();
  let decoded: string;
  try { decoded = decodeURIComponent(uri).normalize('NFC'); }
  catch { throw new ModelResourcePathError('A model resource has an invalid encoded file path.'); }
  return resolveRelativePath(from, decoded);
}

/** USD's authored asset path is not a glTF URI. Preserve literal percent signs,
 * # and ? in names. The renderer must map this exact name to bytes before URL
 * loading; it must never guess by basename or fetch an unmatched network URL. */
export function modelAssetPath(fromFile: string, assetPath: unknown): string {
  const from = modelFilePath(fromFile);
  if (typeof assetPath !== 'string' || !assetPath || assetPath.length > MAX_PATH_BYTES) throw invalid();
  return resolveRelativePath(from, assetPath.normalize('NFC'));
}

function resolveRelativePath(from: string, decoded: string): string {
  if (!decoded || decoded.startsWith('/') || controls.test(decoded) || decoded.includes('\\') || scheme.test(decoded)) throw invalid();
  const parts = from.split('/'); parts.pop();
  for (const part of decoded.split('/')) {
    if (!part) throw invalid();
    if (part === '.') continue;
    if (part === '..') { if (!parts.length) throw invalid(); parts.pop(); }
    else parts.push(part);
  }
  return modelFilePath(parts.join('/'));
}

export function missingModelResources(fromFile: string, references: readonly string[], files: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const reference of references) {
    const path = modelResourcePath(fromFile, reference);
    if (!files.has(path)) missing.add(path);
  }
  return [...missing].sort();
}
