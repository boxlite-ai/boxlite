import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, test } from 'node:test';
import { createCtx, readLink, updateLink, writeLink, type Io } from '../src/context.js';
import { API, cleanup, KEY, linkJson, project, tempDir } from './helpers.js';

let root: string;
const io: Io = { stdout: new Writable({ write: (_c, _e, cb) => cb() }), stderr: new Writable({ write: (_c, _e, cb) => cb() }), stdin: new PassThrough(), isTTY: false };

before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));

test('link.json round-trips and updateLink merges', async () => {
  const dir = await project(root, {});
  assert.equal(await readLink(dir), null);
  assert.equal(await updateLink(dir, { base_version: 3 }), null);
  await writeLink(dir, { app: 'crm', env: 'main', base_version: 1, api_url: API });
  assert.deepEqual(await readLink(dir), { app: 'crm', env: 'main', base_version: 1, api_url: API });
  await updateLink(dir, { base_version: 4 });
  assert.equal((await readLink(dir))?.base_version, 4);
  assert.equal(await readFile(join(dir, '.boxlite/link.json'), 'utf8'), `${JSON.stringify({ app: 'crm', env: 'main', base_version: 4, api_url: API }, null, 2)}\n`);
});

test('invalid link.json is reported with next step', async () => {
  const dir = await project(root, { '.boxlite/link.json': '{not json' });
  await assert.rejects(readLink(dir), (e: Error & { code: string }) => e.code === 'invalid_link');
});

test('env, app and api url precedence: flags > env vars > link.json > defaults', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(2, 'staging') });
  const run = { cwd: dir, io, env: {} as NodeJS.ProcessEnv };

  const fromLink = await createCtx(run, {});
  assert.equal(fromLink.envName, 'staging');
  assert.equal(fromLink.app, 'crm');
  assert.equal(fromLink.apiUrl, API);
  assert.equal(fromLink.baseVersion, 2);
  assert.throws(() => fromLink.api(), (e: Error & { code: string; exit: number }) => e.code === 'unauthenticated' && e.exit === 2);

  const withFlags = await createCtx({ ...run, env: { BOXLITE_API_KEY: KEY, BOXLITE_API_URL: 'http://other.test/' } }, { env: 'preview', json: true });
  assert.equal(withFlags.envName, 'preview');
  assert.equal(withFlags.apiUrl, 'http://other.test/');
  assert.equal(withFlags.api().baseUrl, 'http://other.test');
  assert.equal(withFlags.json, true);
  assert.equal(await withFlags.confirm('?', 'x'), true);

  const unlinked = await createCtx({ cwd: await project(root, {}), io, env: { BOXLITE_API_KEY: KEY, BOXLITE_APP: 'other' } }, {});
  assert.equal(unlinked.envName, 'main');
  assert.equal(unlinked.app, 'other');
  assert.throws(() => unlinked.api(), (e: Error & { code: string }) => e.code === 'missing_api_url');
  await assert.rejects(unlinked.confirm('?', 'delete'), (e: Error & { code: string }) => e.code === 'confirmation_required');
});
