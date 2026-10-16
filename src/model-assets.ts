/** Retained model transfer (ADR 0257). Same portable layout as project archives.
 * Canonical declaration/path validators are vendored unchanged from the platform.
 * No model bytes enter Git or the source write-set. Local files are never pruned. */
import { promises as fs, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { declareModelBundle, MODEL_BUNDLE_LIMITS } from './model-assets/model-bundle-declaration.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/, CHUNK = 1024 * 1024;
interface Reference { id: string; sha256: string }
interface Catalog { version: 1; projectId: string; bundles: Reference[]; incomplete: number }
function catalog(value: unknown, projectId: string): Catalog {
  const v = value as Catalog;
  if (!v || v.version !== 1 || v.projectId !== projectId || !Array.isArray(v.bundles) || v.bundles.length > 128
    || !Number.isInteger(v.incomplete) || v.incomplete < 0 || v.incomplete + v.bundles.length > 128) throw new Error('Invalid model asset index.');
  const ids = new Set<string>(), hashes = new Set<string>();
  for (const ref of v.bundles) {
    if (!ref || typeof ref.id !== 'string' || typeof ref.sha256 !== 'string' || !UUID.test(ref.id) || !SHA.test(ref.sha256) || ids.has(ref.id) || hashes.has(ref.sha256)) throw new Error('Invalid model asset identity.');
    ids.add(ref.id); hashes.add(ref.sha256);
  }
  return { version: 1, projectId, bundles: v.bundles.map(({ id, sha256 }) => ({ id, sha256 })), incomplete: v.incomplete };
}
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function directory(path: string) {
  try { await fs.mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!(await fs.lstat(path)).isDirectory()) throw new Error('Model asset storage must be a regular directory.');
}
async function boundedFile(path: string, limit: number): Promise<Buffer | null> {
  let handle;
  try { handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw new Error('Invalid local model metadata.');
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > limit) throw new Error('Local model metadata exceeds its limit.');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
async function verifiedFile(path: string, sha256: string, bytes: number, signal: AbortSignal) {
  let handle;
  try { handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size !== bytes) throw new Error('A local model resource was changed; keep or move it before retrying.');
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let size = 0;
    for (;;) {
      signal.throwIfAborted(); const part = await handle.read(chunk, 0, chunk.length, null); if (!part.bytesRead) break;
      size += part.bytesRead; if (size > bytes) throw new Error('A local model resource grew during verification.'); hash.update(chunk.subarray(0, part.bytesRead));
    }
    if (size !== bytes || hash.digest('hex') !== sha256) throw new Error('A local model resource was changed; keep or move it before retrying.');
    return true;
  } finally { await handle.close(); }
}
async function readResponse(response: Response, limit: number) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing model response.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
      if (bytes > limit) throw new Error('Model response exceeds its byte limit.'); chunks.push(part.value); }
    return Buffer.concat(chunks, bytes);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function pullModelAssets(folder: string, apiUrl: string, projectId: string, token: string,
  report: (message: string) => void = console.log, outerSignal?: AbortSignal) {
  if (!UUID.test(projectId)) throw new Error('Invalid model project identity.');
  const controller = new AbortController(), signal = outerSignal ? AbortSignal.any([controller.signal, outerSignal]) : controller.signal;
  const stop = () => controller.abort(new Error('Model asset transfer cancelled.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const prefix = `${apiUrl.replace(/\/$/, '')}/api/projects/${projectId}/models`;
  const request = async (suffix: string, limit: number, optional = false): Promise<Buffer | null> => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetch(prefix + suffix, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (response.status === 429 && attempt < 4) {
        const seconds = Math.min(30, Math.max(1, Number(response.headers.get('retry-after')) || 1));
        await response.body?.cancel(); await delay(seconds * 1000, undefined, { signal }); continue;
      }
      if (optional && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Model assets could not be read (HTTP ${response.status}).`); }
      return readResponse(response, limit);
    }
  };
  try {
    const response = await request('/snapshot', 64 * 1024, true);
    if (!response) {
      // Older servers have no retained model capability. Do not silently claim
      // portability when the current source already contains a model reference.
      const parameters = await boundedFile(join(folder, 'src/world/parameters.json'), 256 * 1024);
      if (parameters && /"model"\s*:\s*\{/.test(parameters.toString('utf8'))) throw new Error('This server cannot transfer the model assets referenced by this World.');
      report('  Model asset download is unavailable on this server; source files are retained.'); return;
    }
    const index = catalog(JSON.parse(response.toString('utf8')), projectId);
    const anchor = await fs.realpath(resolve(folder)), trivial = join(anchor, '.trivial'), root = join(trivial, 'model-assets');
    await directory(trivial); await directory(root); await directory(join(root, 'manifests')); await directory(join(root, 'resources'));
    const old = await boundedFile(join(root, 'index.json'), 64 * 1024); if (old) catalog(JSON.parse(old.toString('utf8')), projectId);
    const unique = new Map<string, number>(); let downloaded = 0;
    for (const [position, reference] of index.bundles.entries()) {
      const route = `/${reference.id}/${reference.sha256}`;
      const wrapped = JSON.parse((await request(route + '/manifest', MODEL_BUNDLE_LIMITS.maxManifestBytes + 1024))!.toString('utf8'));
      const declared = declareModelBundle(wrapped.manifest, MODEL_BUNDLE_LIMITS);
      if (wrapped.id !== reference.id || wrapped.sha256 !== reference.sha256 || digest(declared.json) !== reference.sha256) throw new Error('Model manifest identity does not match its contents.');
      const manifestPath = join(root, 'manifests', reference.id + '.json');
      const prior = await boundedFile(manifestPath, MODEL_BUNDLE_LIMITS.maxManifestBytes);
      if (prior && prior.toString('utf8') !== declared.json) throw new Error('A local model manifest was changed; keep or move it before retrying.');
      for (const file of declared.manifest.files) {
        if (unique.has(file.sha256)) { if (unique.get(file.sha256) !== file.bytes) throw new Error('Model resource size conflict.'); continue; }
        unique.set(file.sha256, file.bytes);
        const destination = join(root, 'resources', file.sha256);
        if (await verifiedFile(destination, file.sha256, file.bytes, signal)) continue;
        const temporary = join(root, 'resources', '.partial-' + randomUUID());
        const handle = await fs.open(temporary, 'wx', 0o600), hash = createHash('sha256');
        try {
          for (let i = 0; i < Math.ceil(file.bytes / CHUNK); i++) {
            const bytes = (await request(`${route}/resources/${file.sha256}/chunks/${i}`, CHUNK))!;
            if (bytes.length !== Math.min(CHUNK, file.bytes - i * CHUNK)) throw new Error('Model resource chunk has the wrong size.');
            hash.update(bytes); await handle.writeFile(bytes);
          }
          if (hash.digest('hex') !== file.sha256) throw new Error('Model resource hash mismatch.');
          await handle.sync(); await handle.close();
          try { await fs.link(temporary, destination); downloaded += file.bytes; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await verifiedFile(destination, file.sha256, file.bytes, signal); }
        } finally { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
      }
      if (!prior) {
        const temporary = join(root, 'manifests', '.partial-' + randomUUID());
        try {
          await fs.writeFile(temporary, declared.json, { flag: 'wx', mode: 0o600 });
          try { await fs.link(temporary, manifestPath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if ((await boundedFile(manifestPath, MODEL_BUNDLE_LIMITS.maxManifestBytes))?.toString('utf8') !== declared.json) throw new Error('Local model manifest changed during transfer.'); }
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
      report(`  Model assets: ${position + 1}/${index.bundles.length}`);
    }
    signal.throwIfAborted();
    const temporary = join(root, '.index-' + randomUUID());
    try {
      await fs.writeFile(temporary, JSON.stringify(index) + '\n', { flag: 'wx', mode: 0o600 });
      const current = await boundedFile(join(root, 'index.json'), 64 * 1024); if (current) catalog(JSON.parse(current.toString('utf8')), projectId);
      await fs.rename(temporary, join(root, 'index.json'));
    } finally { await fs.unlink(temporary).catch(() => {}); }
    if (index.bundles.length) report(`✓ ${index.bundles.length} retained model asset(s) available locally (${downloaded} new bytes).`);
    if (index.incomplete) report(`  ${index.incomplete} unfinished model upload(s) remain on Trivial; they are not complete portable assets.`);
  } catch (error) {
    throw new Error(`${(error as Error).message}\nSource and previously verified model files are retained. Retry with \`trivial pull\`.`);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
