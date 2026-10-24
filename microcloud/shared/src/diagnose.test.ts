import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure, lineOfPosition, missingVariableIn } from './diagnose.js';
import { redact } from './redact.js';

const TS = '2026-10-21T10:00:00.000Z';

test('npm ci without a lockfile is classified with a fix', () => {
  const d = classifyFailure({
    step: 'build',
    message: 'build step 1 (npm ci) exited with code 1',
    log_tail: [`${TS} [build] npm error code EUSAGE`, `${TS} [build] npm error The \`npm ci\` command can only install with an existing package-lock.json or`],
  });
  assert.equal(d.cause, 'missing_lockfile');
  assert.match(d.fix, /npm install/);
  assert.equal(d.file, 'package-lock.json');
  assert.equal(d.evidence.length, 3);
});

test('a missing npm script and a generic build error', () => {
  assert.equal(classifyFailure({ step: 'build', message: 'build step 2 (npm run build) exited with code 1', log_tail: ['npm ERR! Missing script: "build"'] }).cause, 'npm_script_missing');
  const generic = classifyFailure({ step: 'build', message: 'build step 2 (npm run build) exited with code 2', log_tail: ['src/a.ts(3,1): error TS2304: Cannot find name x'] });
  assert.equal(generic.cause, 'build_command_failed');
  assert.match(generic.fix, /run `npm run build` locally/);
  assert.equal(classifyFailure({ step: 'build', message: 'the supervisor did not report built/failed for release 3 within 1200 s' }).cause, 'build_timeout');
});

test('health 404 names the service and the path', () => {
  const d = classifyFailure({
    step: 'start',
    message: 'service web failed its health check within 1m0s',
    log_tail: [`${TS} [system] health check for web (http://127.0.0.1:20001/healthz): unhealthy after 1m0s (120 attempt(s), last: HTTP 404)`],
  });
  assert.equal(d.cause, 'health_404');
  assert.match(d.summary, /web answers 404 on its health path \/healthz/);
  assert.match(d.fix, /GET \/healthz/);
});

test('an app listening on a fixed port or on localhost is a port binding problem', () => {
  const refused = `${TS} [system] health check for web (http://127.0.0.1:20001/): unhealthy after 1m0s (120 attempt(s), last: dial tcp 127.0.0.1:20001: connect: connection refused)`;
  const fixed = classifyFailure({ step: 'start', message: 'service web failed its health check within 1m0s', log_tail: [`${TS} [web] Server listening on http://localhost:3000`, refused] });
  assert.equal(fixed.cause, 'port_binding');
  assert.match(fixed.summary, /port 3000, but the platform sets PORT=20001/);
  assert.match(fixed.fix, /0\.0\.0\.0/);
  const silent = classifyFailure({ step: 'start', message: 'service web failed its health check within 1m0s', log_tail: [refused] });
  assert.equal(silent.cause, 'port_binding');
  assert.match(silent.summary, /nothing answered on PORT \(20001\)/);
});

test('a crash on start carries the service stderr', () => {
  const d = classifyFailure({
    step: 'start',
    message: 'service web failed its health check within 1m0s',
    service: { name: 'web', command: 'node server.js' },
    log_tail: [`${TS} [web] TypeError: x is not a function`, `${TS} [system] service web exited with code 1 after 120ms; restarting in 1s`],
  });
  assert.equal(d.cause, 'crash_on_start');
  assert.match(d.summary, /web exited with code 1/);
  assert.deepEqual(d.evidence, [`${TS} [web] TypeError: x is not a function`]);
  assert.match(d.fix, /node server\.js/);
  const mod = classifyFailure({ step: 'start', message: 'x', log_tail: [`${TS} [web] Error: Cannot find module 'express'`] });
  assert.equal(mod.cause, 'module_not_found');
  assert.match(mod.fix, /npm install express/);
});

test('a migration SQL error points at file and line', () => {
  const sql = '-- deals\ncreate table deals (\n  id serial primary key,\n  title txt not null\n);\n';
  const d = classifyFailure({ step: 'migrate', message: 'migration 0002_deals.sql failed: type "txt" does not exist', migrations: [{ file: '0002_deals.sql', sql }] });
  assert.equal(d.cause, 'migration_sql_error');
  assert.equal(d.file, 'migrations/0002_deals.sql');
  assert.equal(d.line, 4);
  assert.match(d.summary, /^migrations\/0002_deals\.sql:4: type "txt" does not exist/);
  const near = classifyFailure({ step: 'migrate', message: 'migration 0002_deals.sql failed: syntax error at or near "tabel"', migrations: [{ file: '0002_deals.sql', sql: 'create\ntabel x ();' }] });
  assert.equal(near.line, 2);
  assert.equal(classifyFailure({ step: 'migrate', message: 'applied migration(s) changed: 0001_init.sql' }).cause, 'migration_changed');
  assert.equal(lineOfPosition('a\nbc\nd', 4), 2);
});

test('unknown failures still give a runnable next step', () => {
  const d = classifyFailure({ step: 'box', message: 'boxlite: POST /boxes → 500', deployment: 4 });
  assert.equal(d.cause, 'unknown');
  assert.match(d.fix, /boxlite-app app deployment 4 --logs/);
});

test('redact masks App keys, box tokens and database passwords', () => {
  const key = `bxl_app_${'a'.repeat(28)}wxyz`;
  assert.equal(redact(`key=${key}`), 'key=bxl_app_…wxyz');
  assert.equal(redact('bxt_abcdefghij2345'), 'bxt_…2345');
  assert.equal(redact('DATABASE_URL=postgresql://neondb_owner:s3cr3t@ep-x.neon.tech/neondb?sslmode=require'), 'DATABASE_URL=postgresql://neondb_owner:****@ep-x.neon.tech/neondb?sslmode=require');
  assert.equal(redact('nothing here'), 'nothing here');
});

test('a service that exits because a variable is missing names it, with the command that sets it', () => {
  const tail = (line: string) => [`${TS} [web] ${line}`, `${TS} [system] service web exited with code 1 after 30ms; restarting in 1s`];
  const token = classifyFailure({ step: 'start', message: 'service web exited with code 1 before answering /healthz', service: { name: 'web', command: 'node server.js' }, log_tail: tail('Error: SLACK_TOKEN is not set') });
  assert.equal(token.cause, 'missing_variable');
  assert.match(token.summary, /web needs SLACK_TOKEN/);
  // A credential comes from the org's secret store, never from a value the agent makes up.
  assert.match(token.fix, /boxlite-app app secrets set slack-token`, then `boxlite-app app secrets ref SLACK_TOKEN app\/slack-token/);
  assert.match(token.fix, /ask the user/);
  const plain = classifyFailure({ step: 'start', message: 'x', service: { name: 'web', command: 'node server.js' }, log_tail: tail('LOG_LEVEL is required') });
  assert.equal(plain.cause, 'missing_variable');
  assert.match(plain.fix, /boxlite-app app vars set LOG_LEVEL=<value>/);
  assert.equal(missingVariableIn('Missing environment variable: STRIPE_KEY'), 'STRIPE_KEY');
  assert.equal(missingVariableIn('the value is not set yet'), undefined);
});

test('a hard-coded port that is already taken is a port problem, not a plain crash', () => {
  const d = classifyFailure({
    step: 'start',
    message: 'web exited with code 1 before it became healthy',
    log_tail: ['[web] Error: listen EADDRINUSE: address already in use 0.0.0.0:3000', '[web]     at Server.setupListenHandle [as _listen2] (node:net:1908:16)', '[system] service web exited with code 1 after 210ms; restarting in 1s'],
    service: { name: 'web', command: 'node server.js', health: '/healthz' },
  });
  assert.equal(d.cause, 'port_binding');
  assert.match(d.summary, /port 3000, which is already taken/);
  assert.match(d.fix, /process\.env\.PORT/);
});

test('a service listening on its own fixed port is a port problem even after the platform stops it', () => {
  const d = classifyFailure({
    step: 'start',
    message: 'web exited with code 143 before it became healthy',
    log_tail: [
      '[web] listening on port 3000',
      '[system] health check for web (http://127.0.0.1:20001/healthz): unhealthy after 1m0s (40 attempt(s), last: dial tcp 127.0.0.1:20001: connect: connection refused)',
      '[system] service web exited with code 143 after 60.2s; restarting in 1s',
    ],
    service: { name: 'web', command: 'node server.js', health: '/healthz' },
  });
  assert.equal(d.cause, 'port_binding');
  assert.match(d.summary, /port 3000, but the platform sets PORT=20001/);
});

test('a program nothing installed is named, at start and at build; an app saying "not found" is not', () => {
  const start = classifyFailure({
    step: 'start',
    message: 'service web failed its health check within 1m0s',
    service: { name: 'web', command: 'gunicorn app:app' },
    log_tail: [`${TS} [web] sh: 1: gunicorn: not found`, `${TS} [system] service web exited with code 127 after 5ms; restarting in 1s`],
  });
  assert.equal(start.cause, 'command_not_found');
  assert.equal(start.summary, '`gunicorn` is not installed in the Box (exit 127)');
  assert.match(start.fix, /requirements\.txt/);
  const build = classifyFailure({ step: 'build', message: 'build step 2 (next build) exited with code 127', log_tail: [`${TS} [build] /bin/sh: line 1: next: command not found`] });
  assert.equal(build.cause, 'command_not_found');
  assert.match(build.summary, /`next`/);
  const app = classifyFailure({
    step: 'start',
    message: 'service web failed its health check within 1m0s',
    service: { name: 'web', command: 'node server.js' },
    log_tail: [`${TS} [web] Error: not found`, `${TS} [system] service web exited with code 1 after 120ms; restarting in 1s`],
  });
  assert.equal(app.cause, 'crash_on_start');
});
