import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { DbConn } from '../src/appdb.js';
import { DbReaders } from '../src/dbreader.js';
import { READER_ROLE } from '../src/sqlguard.js';
import { createApp, harness, type Harness } from './helpers.js';

const OWNER = 'postgresql://neondb_owner:pw@ep-main.neon.test/neondb?sslmode=verify-full';
const DEV = 'postgresql://neondb_owner:pw@ep-dev.neon.test/neondb?sslmode=verify-full';

let h: Harness;
let sql: string[];
let logs: string[];
let readers: DbReaders;
beforeEach(async () => {
  h?.close();
  h = harness();
  await createApp(h);
  const app = h.ctx.store.appByName('crm')!;
  h.ctx.store.updateApp(app.id, { neon_project_id: 'proj-1', neon_main_branch_id: 'br-main' });
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'main')!.id, { neon_branch_id: 'br-main', db_url: OWNER });
  sql = [];
  logs = [];
  // Every connection: who logged in, and what it ran. The reader holds pg_read_all_data.
  const connect = async (url: string): Promise<DbConn> => {
    const user = decodeURIComponent(new URL(url).username);
    const pw = decodeURIComponent(new URL(url).password);
    return {
      async query(text: string) {
        sql.push(`${user}${user === READER_ROLE ? `(${pw})` : ''}: ${text}`);
        return { rows: [{ ok: true }] };
      },
      cursor: () => {
        throw new Error('not used');
      },
      async end() {},
    };
  };
  readers = new DbReaders({ store: h.ctx.store, neon: h.neon, connect, log: (l) => logs.push(l), retryMs: 1 });
});
after(() => h.close());

test('first use creates the reader through the Neon API, grants read-all, defaults it to read-only, caches the password', async () => {
  const url = await readers.urlFor(OWNER);
  assert.equal(new URL(url).username, READER_ROLE);
  assert.equal(new URL(url).password, 'pw-br-main');
  assert.equal(new URL(url).hostname, 'ep-main.neon.test');
  assert.deepEqual(h.neon.calls, [`create-role br-main ${READER_ROLE}`]);
  assert.deepEqual(sql, [
    `neondb_owner: GRANT pg_read_all_data TO ${READER_ROLE}`,
    `${READER_ROLE}(pw-br-main): BEGIN TRANSACTION READ WRITE`,
    `${READER_ROLE}(pw-br-main): ALTER ROLE ${READER_ROLE} SET default_transaction_read_only = on`,
    `${READER_ROLE}(pw-br-main): COMMIT`,
    `${READER_ROLE}(pw-br-main): SELECT pg_has_role(current_user, 'pg_read_all_data', 'USAGE') AS ok`,
  ]);
  // Cached: the next read costs no API call and no SQL.
  h.neon.calls = [];
  sql = [];
  assert.equal(await readers.urlFor(OWNER), url);
  assert.deepEqual(h.neon.calls, []);
  assert.deepEqual(sql, []);
});

test('the password is never logged', async () => {
  await readers.urlFor(OWNER);
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !l.includes('pw-br-main')), logs.join('\n'));
});

test('refresh after a refused login picks up the current password', async () => {
  await readers.urlFor(OWNER);
  h.neon.roles.get('br-main')!.get(READER_ROLE)!.password = 'rotated';
  const url = await readers.refresh(OWNER);
  assert.equal(new URL(url).password, 'rotated');
  assert.equal(new URL(await readers.urlFor(OWNER)).password, 'rotated', 'the cache is updated');
});

test('a SQL-created reader (no_login) is dropped and re-created through the API', async () => {
  h.neon.roles.set('br-main', new Map([[READER_ROLE, { authMethod: 'no_login', password: '' }]]));
  await readers.urlFor(OWNER);
  assert.deepEqual(h.neon.calls, [`delete-role br-main ${READER_ROLE}`, `create-role br-main ${READER_ROLE}`]);
  assert.equal((await h.neon.getRole('proj-1', 'br-main', READER_ROLE))?.authMethod, 'password');
});

test('before branching, SQL-created readers are removed from every branch of the project', async () => {
  h.neon.branches = ['br-main', 'br-dev', 'br-main-before-restore'];
  for (const b of ['br-main', 'br-main-before-restore']) h.neon.roles.set(b, new Map([[READER_ROLE, { authMethod: 'no_login', password: '' }]]));
  h.neon.roles.set('br-dev', new Map([[READER_ROLE, { authMethod: 'password', password: 'x' }]]));
  await readers.prepareBranching('proj-1');
  assert.deepEqual(h.neon.calls.sort(), [`delete-role br-main ${READER_ROLE}`, `delete-role br-main-before-restore ${READER_ROLE}`]);
  assert.ok(h.neon.roles.get('br-dev')!.has(READER_ROLE), 'API-created readers stay');
});

test('a branch that is still initialising is waited for (reveal_password 404)', async () => {
  const app = h.ctx.store.appByName('crm')!;
  await h.request('/v1/apps/crm/envs', { method: 'POST', key: 'test-admin-token', json: { name: 'dev' } });
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'dev')!.id, { neon_branch_id: 'br-dev', db_url: DEV });
  // Neon answers 409 (the copy from main exists) but hides the password until the branch is ready.
  let misses = 2;
  const reveal = h.neon.revealRolePassword.bind(h.neon);
  h.neon.roles.set('br-dev', new Map([[READER_ROLE, { authMethod: 'password', password: 'pw-copied' }]]));
  h.neon.revealRolePassword = async (p, b, n) => {
    if (misses-- > 0) {
      const { UpstreamError } = await import('../src/errors.js');
      throw new UpstreamError('neon', 404, 'not ready');
    }
    return reveal(p, b, n);
  };
  const url = await readers.urlFor(DEV);
  assert.equal(new URL(url).password, 'pw-copied');
  assert.equal(new URL(url).hostname, 'ep-dev.neon.test');
});

test('concurrent first reads provision once', async () => {
  const urls = await Promise.all([readers.refresh(OWNER), readers.refresh(OWNER), readers.refresh(OWNER)]);
  assert.equal(new Set(urls).size, 1);
  assert.equal(h.neon.calls.filter((c) => c.startsWith('create-role')).length, 1);
});

test('the reader password stays out of the spec, the agent context and the console', async () => {
  await readers.urlFor(OWNER);
  for (const path of ['/v1/apps/crm', '/v1/apps/crm/context', '/v1/apps/crm/envs/main/db', '/v1/apps/crm/envs/main/dev-env']) {
    const res = await h.request(path, { key: 'test-admin-token' });
    assert.ok(!(await res.text()).includes('pw-br-main'), path);
  }
});

test('env create clears SQL-created readers before Neon creates the schema-only branch', async () => {
  const res = await h.request('/v1/apps/crm/envs', { method: 'POST', key: 'test-admin-token', json: { name: 'staging', from: 'main' } });
  assert.equal(res.status, 201, await res.clone().text());
  assert.deepEqual(h.appdb.branchingChecks, ['proj-1']);
  assert.ok(h.neon.calls.some((c) => c === 'branch staging br-main schema-only'));
});

test('a new database provisions the reader for main right away', async () => {
  const app = h.ctx.store.appByName('crm')!;
  h.ctx.store.updateApp(app.id, { neon_project_id: null, neon_main_branch_id: null });
  h.ctx.store.updateEnv(h.ctx.store.envByName(app.id, 'main')!.id, { neon_branch_id: null, db_url: null });
  await h.ctx.resources.ensureDatabase(app.id, h.ctx.store.envByName(app.id, 'main')!.id);
  assert.deepEqual(h.appdb.readers, ['postgresql://neondb_owner:pw@ep-main.neon.test/neondb?sslmode=verify-full']);
});
