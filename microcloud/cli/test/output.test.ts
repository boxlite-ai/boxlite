import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLines, checkSummary, formatAgo, formatBytes, formatChange, formatMs, stepLine, table } from '../src/output.js';
import { specToToml } from '../src/toml-edit.js';
import { parseDotenv } from '../src/commands/vars.js';
import { renderDotenv } from '../src/commands/dev.js';

test('formatChange matches the PRD plan layout', () => {
  assert.equal(formatChange({ kind: '+', path: 'database', to: 'neon branch main, run migrations/0001_init.sql' }), '  + database        neon branch main, run migrations/0001_init.sql');
  assert.equal(formatChange({ kind: '~', path: 'variables.LOG_LEVEL', from: null, to: 'info' }), '  ~ variables       LOG_LEVEL: (none) → info');
  assert.equal(formatChange({ kind: 'online_only', path: 'domains.custom', to: ['crm.acme.com'] }), '  ! online only     domains.custom: crm.acme.com   (run `boxlite-app app pull`)');
  assert.equal(formatChange({ kind: '-', path: 'volumes.uploads', from: '/data/uploads' }), '  - volumes         uploads: /data/uploads → (removed)');
});

test('stepLine renders the PRD deploy lines', () => {
  assert.equal(stepLine(2, 'build', 'npm ci && npm run build', 41000), '#2  Building    npm ci && npm run build   41s');
  assert.equal(stepLine(2, 'live', 'https://cp/crm · spec v3'), '#2  Live        https://cp/crm · spec v3');
  assert.equal(stepLine(3, 'start', 'web  npm start', 2500, 'failed'), '#3  Starting    web  npm start   failed   3s');
  assert.equal(stepLine(1, 'custom-step', '', 12), '#1  Custom-step   12ms');
});

test('formatters', () => {
  assert.equal(formatMs(999), '999ms');
  assert.equal(formatMs(61000), '1m01s');
  assert.equal(formatBytes(1.3 * 1024 * 1024), '1.3 MB');
  assert.equal(formatBytes(512), '512 B');
  const now = Date.parse('2026-10-21T10:00:00Z');
  assert.equal(formatAgo('2026-10-21T09:58:00Z', now), '2m ago');
  assert.equal(formatAgo('2026-10-19T09:58:00Z', now), '2d ago');
  assert.deepEqual(table([['a', 'bbb', 'c'], ['dd', 'e', 'f']]), ['a   bbb  c', 'dd  e    f']);
});

test('check lines and summary', () => {
  const result = { ok: false, errors: [{ file: 'boxlite.toml', line: 14, rule: 'unknown_field', message: 'unknown field "x"' }], warnings: [{ rule: 'no_lockfile', message: 'no lock' }] };
  assert.deepEqual(checkLines(result), ['boxlite.toml:14  unknown_field  unknown field "x"', 'warning  no_lockfile  no lock']);
  assert.equal(checkSummary(result), '1 error, 1 warning');
  assert.equal(checkSummary({ ok: true, errors: [], warnings: [] }), 'ok');
});

test('specToToml drops platform fields and round-trips the manifest shape', () => {
  const toml = specToToml({
    app: 'crm',
    environment: 'main',
    version: 3,
    deployment: 7,
    runtime: { image: 'node', size: 'small', build: ['npm ci'], output: null },
    services: [{ name: 'web', command: 'node server.js', port: true, health: '/healthz' }, { name: 'site', static: 'dist/' }],
    database: { migrations: 'migrations/', applied: [{ file: '0001_init.sql' }] },
    domains: { builtin: 'crm', custom: [] },
    access: 'private',
    variables: { LOG_LEVEL: 'info' },
    secrets: {},
    assigned: { box_id: 'x' },
  });
  assert.match(toml, /^# boxlite\.toml — written by `boxlite-app app pull` from spec v3 of environment main\n/);
  assert.match(toml, /\[runtime\]\nimage = "node"\nsize = "small"\nbuild = \[ "npm ci" \]/);
  assert.match(toml, /\[\[service\]\]\nname = "web"\ncommand = "node server.js"\nport = 3000\nhealth = "\/healthz"/);
  assert.match(toml, /\[database\]\nmigrations = "migrations\/"/);
  assert.doesNotMatch(toml, /applied|assigned|builtin|deployment|secrets/);
});

test('dotenv parse and render', () => {
  assert.deepEqual(parseDotenv('# c\nexport A=1\nB="x y" \nC=\'q\'\nD=plain # trailing\n\nbad line\n'), { A: '1', B: 'x y', C: 'q', D: 'plain' });
  assert.equal(renderDotenv({ A: '1', B: 'x y', C: 'postgres://u:p@h/db?sslmode=require' }), 'A=1\nB="x y"\nC=postgres://u:p@h/db?sslmode=require\n');
});
