import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { localDatabaseUrl, startDbBridge, type BridgeSocket } from '../src/dbproxy.js';
import { cleanup, cli, JSON_HEADERS, linkJson, mockApi, project, tempDir } from './helpers.js';

let root: string;
before(async () => {
  root = await tempDir();
});
after(async () => cleanup(root));

const E = '/v1/apps/crm/envs/main';

/** Stands in for the control plane's WebSocket: records what it was sent, answers on demand. */
class FakeSocket implements BridgeSocket {
  binaryType = 'blob';
  readyState = 0;
  sent: Buffer[] = [];
  closed = false;
  private listeners: Record<string, ((ev: { data: unknown }) => void)[]> = {};
  addEventListener(type: string, fn: (ev: { data: unknown }) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, data?: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn({ data });
  }
  send(data: Uint8Array): void {
    this.sent.push(Buffer.from(data));
  }
  close(): void {
    this.closed = true;
  }
}

const dial = (port: number) => new Promise<Socket>((resolve) => { const s = connect(port, '127.0.0.1', () => resolve(s)); });
const tick = () => new Promise((r) => setTimeout(r, 30));

test('each local connection gets its own WebSocket; bytes pass both ways, early bytes wait for open', async () => {
  const sockets: FakeSocket[] = [];
  const bridge = await startDbBridge(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }, 0);
  try {
    const a = await dial(bridge.port);
    a.write('startup');
    await tick();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0]!.binaryType, 'arraybuffer');
    assert.deepEqual(sockets[0]!.sent, [], 'nothing is sent before the WebSocket opens');
    sockets[0]!.emit('open');
    assert.equal(Buffer.concat(sockets[0]!.sent).toString(), 'startup');
    const got = new Promise<string>((r) => a.once('data', (d) => r(String(d))));
    sockets[0]!.emit('message', new TextEncoder().encode('R-ok').buffer);
    assert.equal(await got, 'R-ok');
    const b = await dial(bridge.port);
    await tick();
    assert.equal(sockets.length, 2);
    assert.equal(bridge.open(), 2);
    a.destroy();
    await tick();
    assert.equal(sockets[0]!.closed, true);
    b.destroy();
  } finally {
    await bridge.close();
  }
});

test('a cancel request (written, then closed at once) is still delivered once the WebSocket opens', async () => {
  const sockets: FakeSocket[] = [];
  const bridge = await startDbBridge(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }, 0);
  try {
    const s = await dial(bridge.port);
    s.end(Buffer.from('cancel-packet'));
    await tick();
    assert.equal(sockets[0]!.closed, false);
    sockets[0]!.emit('open');
    assert.equal(Buffer.concat(sockets[0]!.sent).toString(), 'cancel-packet');
    assert.equal(sockets[0]!.closed, true);
  } finally {
    await bridge.close();
  }
});

test('a WebSocket that never opens answers the local client with a Postgres FATAL error', async () => {
  const errors: string[] = [];
  let ws!: FakeSocket;
  const bridge = await startDbBridge(() => (ws = new FakeSocket()), 0, { onError: (m) => errors.push(m) });
  try {
    const s = await dial(bridge.port);
    const reply = new Promise<Buffer>((r) => s.once('data', r));
    await tick();
    ws.emit('error');
    const msg = await reply;
    assert.equal(String.fromCharCode(msg[0]!), 'E');
    assert.match(msg.toString(), /FATAL.*08006.*control plane refused/s);
    assert.equal(errors.length, 1);
  } finally {
    await bridge.close();
  }
});

test('the local DATABASE_URL carries no password and no TLS on the loopback leg', () => {
  assert.equal(localDatabaseUrl(5432, 'neondb'), 'postgresql://boxlite@127.0.0.1:5432/neondb?sslmode=disable');
});

test('db proxy refuses an env without a database, and a port that is taken, before listening', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/db`, method: 'GET' }).reply(200, { status: 'none' }, { headers: JSON_HEADERS });
  const none = await cli(['app', 'db', 'proxy', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(none.code, 4);
  assert.match(JSON.parse(none.stderr).error.next, /\[database\]/);

  const taken = createServer();
  await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
  const port = (taken.address() as AddressInfo).port;
  try {
    pool.intercept({ path: `${E}/db`, method: 'GET' }).reply(200, { status: 'ready', database: 'neondb' }, { headers: JSON_HEADERS });
    const busy = await cli(['app', 'db', 'proxy', '--port', String(port), '--json'], { cwd: dir, dispatcher: agent });
    assert.equal(busy.code, 1);
    const err = JSON.parse(busy.stderr).error;
    assert.equal(err.code, 'conflict');
    assert.match(err.next, /--port/);
  } finally {
    taken.close();
  }
});

test('db proxy prints the local DATABASE_URL (NDJSON with --json) and stops on Ctrl-C', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/db`, method: 'GET' }).reply(200, { status: 'ready', database: 'neondb' }, { headers: JSON_HEADERS });
  const run = cli(['app', 'db', 'proxy', '--port', '0', '--write', '--json'], { cwd: dir, dispatcher: agent });
  await new Promise((r) => setTimeout(r, 150));
  process.emit('SIGINT');
  const res = await run;
  assert.equal(res.code, 0, res.stderr);
  const ev = JSON.parse(res.lines[0]!);
  assert.equal(ev.event, 'listening');
  assert.equal(ev.role, 'owner');
  assert.match(ev.database_url, /^postgresql:\/\/boxlite@127\.0\.0\.1:\d+\/neondb\?sslmode=disable$/);
});

test('db export streams to a file; CSV needs a table; --json needs -o', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/db/export?table=deals&format=csv`, method: 'GET' }).reply(200, 'id,title\n1,a\n', { headers: { 'content-type': 'text/csv' } });
  const ok = await cli(['app', 'db', 'export', '--table', 'deals', '-o', 'deals.csv', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { file: 'deals.csv', format: 'csv', table: 'deals', bytes: 13 });
  assert.equal(await readFile(join(dir, 'deals.csv'), 'utf8'), 'id,title\n1,a\n');

  pool.intercept({ path: `${E}/db/export?format=sql`, method: 'GET' }).reply(200, 'BEGIN;\nCOMMIT;\n', { headers: { 'content-type': 'application/sql' } });
  const out = await cli(['app', 'db', 'export'], { cwd: dir, dispatcher: agent });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, 'BEGIN;\nCOMMIT;\n');

  const csv = await cli(['app', 'db', 'export', '--format', 'csv', '--json'], { cwd: dir, dispatcher: agent });
  assert.match(JSON.parse(csv.stderr).error.message, /one table/);
  const json = await cli(['app', 'db', 'export', '--format', 'sql', '--json'], { cwd: dir, dispatcher: agent });
  assert.match(JSON.parse(json.stderr).error.message, /-o/);
});

test('db import needs --yes (on main always), then posts the CSV', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) });
  await writeFile(join(dir, 'deals.csv'), 'title,amount\nx,1\n');
  const { agent, pool } = mockApi();
  const tty = await cli(['app', 'db', 'import', 'deals.csv', '--table', 'deals'], { cwd: dir, dispatcher: agent, isTTY: true });
  assert.equal(tty.code, 10, 'main: a terminal is not enough, --yes is required');
  assert.match(tty.stderr, /--yes/);
  pool.intercept({ path: `${E}/db/import?table=deals`, method: 'POST' }).reply(200, { table: 'deals', rows: 1, columns: ['title', 'amount'], snapshot: 'dbs_1' }, { headers: JSON_HEADERS });
  const ok = await cli(['app', 'db', 'import', 'deals.csv', '--table', 'deals', '--yes', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).rows, 1);
  const missing = await cli(['app', 'db', 'import', 'nope.csv', '--table', 'deals', '--yes', '--json'], { cwd: dir, dispatcher: agent });
  assert.equal(missing.code, 4);
});

test('app dev: DATABASE_URL is the local proxy (no password) in .env.local', async () => {
  const toml = 'name = "crm"\n[runtime]\nimage = "node"\n[[service]]\nname = "web"\ncommand = "node -e \\"console.log(\'db=\' + process.env.DATABASE_URL)\\""\nport = 3000\n[database]\n';
  const dir = await project(root, { '.boxlite/link.json': linkJson(1), 'boxlite.toml': toml });
  const { agent, pool } = mockApi();
  pool.intercept({ path: `${E}/dev-env`, method: 'GET' }).reply(200, { env: { BOXLITE_ENV: 'main', LOG_LEVEL: 'info' }, database: { name: 'neondb' } }, { headers: JSON_HEADERS });
  pool.intercept({ path: `${E}/db`, method: 'GET' }).reply(200, { status: 'ready', database: 'neondb' }, { headers: JSON_HEADERS });
  const res = await cli(['app', 'dev'], { cwd: dir, dispatcher: agent });
  assert.equal(res.code, 0, res.stderr + res.stdout);
  const dotenv = await readFile(join(dir, '.env.local'), 'utf8');
  const url = /^DATABASE_URL=(.*)$/m.exec(dotenv)?.[1] ?? '';
  assert.match(url, /^"?postgresql:\/\/boxlite@127\.0\.0\.1:\d+\/neondb\?sslmode=disable"?$/);
  assert.match(res.stdout, /DATABASE_URL=postgresql:\/\/boxlite@127\.0\.0\.1:\d+\/neondb\?sslmode=disable \(local proxy/);
  assert.doesNotMatch(dotenv, /:[^@/]+@/, 'no password anywhere in .env.local');
});
