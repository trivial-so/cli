import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let folder, runtime, loadDevDataPlane;
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'trivial-runtime-test-'));
  const outfile = join(folder, 'runtime.mjs');
  await build({
    stdin: { contents: "export { loadDevRuntime } from './src/platform/dev-handler-runtime.ts'; export { loadDevDataPlane } from './src/platform/dev-data-plane-node.ts';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  });
  const module = await import(pathToFileURL(outfile).href);
  runtime = module.loadDevRuntime(); loadDevDataPlane = module.loadDevDataPlane;
});
after(async () => { if (folder) await rm(folder, { recursive: true, force: true }); });

// Captured database calls verify the public runtime's wire and parameter boundary.
// PostgreSQL ordering and RLS are properties of the database, not of this stub.
function database(rows = []) {
  const calls = [];
  const db = {
    transaction: async run => run(db),
    exec: async () => {},
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('pg_attribute')) return { rows: [{ name: 'id', def: null, comment: null }, { name: 'note', def: null, comment: null }] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      return { rows };
    },
  };
  return { db, calls };
}

test('row mutations bind exact bigint and numeric-looking text keys', async () => {
  for (const id of ['9007199254740993', '007', '', 'a-key']) {
    const { db, calls } = database([{ id, note: 'changed' }]);
    const ctx = runtime.__devMakeCtx(db, { userId: 'alice', role: null });
    await ctx.update('items', id, { note: 'changed' });
    await ctx.remove('items', id);
    assert.deepEqual(calls.find(call => call.sql.startsWith('UPDATE')).params, ['changed', id]);
    assert.deepEqual(calls.find(call => call.sql.startsWith('DELETE')).params, [id]);
  }
});

test('already-unsafe numeric mutation keys refuse before database access', async () => {
  for (const id of [9007199254740992, 1.5, Infinity]) {
    const { db, calls } = database();
    const ctx = runtime.__devMakeCtx(db, { userId: 'alice', role: null });
    await assert.rejects(ctx.update('items', id, { note: 'changed' }), /safe integers/);
    await assert.rejects(ctx.remove('items', id), /safe integers/);
    assert.equal(calls.length, 0);
  }
});

test('bigint values, arrays and continuation keys survive JSON', async () => {
  const { db } = database([{ id: 9007199254740993n, note: [9007199254740995n] }, { id: 9007199254740994n }]);
  const page = await runtime.__devMakeCtx(db, { userId: 'alice', role: null }).list('items', { limit: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(page)), {
    rows: [{ id: '9007199254740993', note: ['9007199254740995'] }], nextCursor: '9007199254740993',
  });
});

test('HTTP pagination forwards exact strings, including an empty text key', async () => {
  for (const cursor of ['9007199254740993', '007', '']) {
    const { db, calls } = database();
    const plane = loadDevDataPlane({ db, projectId: 'project', origin: 'http://127.0.0.1' });
    const url = new URL('/api/data/project/items?cursor=' + encodeURIComponent(cursor), 'http://127.0.0.1');
    const response = await plane.dispatch(new Request(url), url);
    assert.equal(response.status, 200);
    assert.deepEqual(calls.find(call => call.sql.includes('WHERE id >')).params, [cursor, 51]);
  }
});


test('unusable incoming or emitted cursors refuse explicitly', async () => {
  for (const cursor of ['x'.repeat(513), 9007199254740992, 1.5]) {
    const { db } = database();
    const ctx = runtime.__devMakeCtx(db, { userId: 'alice', role: null });
    await assert.rejects(ctx.list('items', { cursor }), /cursor must/);
  }
  const { db } = database([{ id: 'x'.repeat(513) }, { id: 'y' }]);
  const ctx = runtime.__devMakeCtx(db, { userId: 'alice', role: null });
  await assert.rejects(ctx.list('items', { limit: 1 }), /cursor must/);
});
