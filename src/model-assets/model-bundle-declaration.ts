import { modelFilePath } from './model-resource-path.js';

export interface ModelBundleFile { readonly path: string; readonly sha256: string; readonly bytes: number }
export interface ModelBundleManifest {
  readonly version: 1;
  readonly entry: string;
  readonly files: readonly ModelBundleFile[];
}
/** Admission limits are supplied by trusted service configuration, never JSON
 * from the importer. These do not replace owner quota or decoded-scene limits. */
export interface ModelBundleLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxManifestBytes: number;
}
// Storage intake ceilings, not decoded-model sizes or plan allowances. Shared
// with native inspection so oversized selections fail before hashing/upload.
export const MODEL_BUNDLE_LIMITS: Readonly<ModelBundleLimits> = Object.freeze({ maxFiles: 256,
  maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024, maxManifestBytes: 512 * 1024 });
export class ModelBundleError extends Error {
  readonly code = 'MODEL_BUNDLE_INVALID';
  constructor(message: string) { super(message); this.name = 'ModelBundleError'; }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ModelBundleError('Use a complete model bundle manifest.');
  }
  return value as Record<string, unknown>;
}

/** Canonical v1 identity: JSON UTF-8, fixed key order, NFC names and files sorted
 * by UTF-8 path bytes. A hash identifies content; it grants no read authority.
 * This validates a declaration, not byte presence or successful model decoding. */
export function declareModelBundle(value: unknown, limits: ModelBundleLimits) {
  for (const limit of [limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes, limits.maxManifestBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new ModelBundleError('Model bundle limits are unavailable.');
  }
  const input = record(value, ['version', 'entry', 'files']);
  if (input.version !== 1) throw new ModelBundleError('This model bundle version is not supported.');
  const entry = modelFilePath(input.entry);
  const format = /\.(gltf|glb|usdc)$/i.exec(entry)?.[1].toLowerCase() as 'gltf' | 'glb' | 'usdc' | undefined;
  if (!format) throw new ModelBundleError('Choose a glTF, GLB or USDC entry file.');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > limits.maxFiles) {
    throw new ModelBundleError('The model bundle has too many files or no files.');
  }

  const paths = new Set<string>();
  const blobs = new Map<string, number>();
  let totalBytes = 0;
  let uniqueBytes = 0;
  const files: ModelBundleFile[] = [];
  for (const item of input.files) {
    const file = record(item, ['path', 'sha256', 'bytes']);
    const path = modelFilePath(file.path);
    if (paths.has(path)) throw new ModelBundleError('Two model files have the same relative path.');
    if (typeof file.sha256 !== 'string' || file.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new ModelBundleError('A model file has an invalid content hash.');
    }
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || file.bytes > limits.maxFileBytes || file.bytes > limits.maxTotalBytes - totalBytes) {
      throw new ModelBundleError('The model files exceed the import size limit or have an invalid size.');
    }
    const previousSize = blobs.get(file.sha256);
    if (previousSize !== undefined && previousSize !== file.bytes) {
      throw new ModelBundleError('Files with the same content hash must have the same size.');
    }
    if (previousSize === undefined) { blobs.set(file.sha256, file.bytes); uniqueBytes += file.bytes; }
    totalBytes += file.bytes;
    paths.add(path);
    files.push(Object.freeze({ path, sha256: file.sha256, bytes: file.bytes }));
  }
  if (!paths.has(entry)) throw new ModelBundleError('The model entry file is missing from the bundle.');
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) throw new ModelBundleError('A model file is also used as a folder.');
      parts.pop();
    }
  }
  const encoder = new TextEncoder();
  files.sort((a, b) => {
    const left = encoder.encode(a.path), right = encoder.encode(b.path);
    for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
    return left.length - right.length;
  });
  const manifest: ModelBundleManifest = Object.freeze({ version: 1, entry, files: Object.freeze(files) });
  const json = JSON.stringify(manifest);
  if (new TextEncoder().encode(json).length > limits.maxManifestBytes) throw new ModelBundleError('The model manifest is too large.');
  return Object.freeze({ manifest, json, format, totalBytes, uniqueBytes, uniqueFiles: blobs.size });
}

