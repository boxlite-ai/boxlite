import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextFindings, type AgentContext } from './agent-context.js';
import { buildWarnings } from './build-warnings.js';

const NOW = '2026-10-21T10:00:00.000Z';

function base(): Omit<AgentContext, 'next_actions'> {
  return {
    app: 'crm',
    env: 'main',
    control_plane: 'https://cp.test',
    generated_at: NOW,
    status: 'live',
    urls: { app: 'https://cp.test/crm', health: 'https://cp.test/crm/healthz', login: null },
    access: { level: 'private', source: 'manifest' },
    environments: [],
    live: { deployment: 2, spec_version: 2, live_at: NOW },
    box: { id: 'b1', state: 'running' },
    runtime: { image: 'node', size: 'small', build: [] },
    services: [{ name: 'web', exposed: true, command: 'node server.js', static: null, health_path: '/healthz', state: 'running', health: 'healthy', restarts: 0, last_exit_code: null }],
    schedules: [],
    database: null,
    volumes: [],
    auth: { enabled: false, providers: [], protect: [], login_url: '', users: 0 },
    variables: [],
    deployments: [{ number: 2, kind: 'deploy', status: 'live', message: null, created_at: NOW, finished_at: NOW, spec_version: 2, error: null }],
    recent_errors: [],
    cli: { latest_version: null },
  };
}

test('a healthy environment has no findings', () => {
  assert.deepEqual(contextFindings(base()), []);
});

test('findings are ranked: errors first, each with a fix', () => {
  const c = base();
  c.deployments.unshift({ number: 3, kind: 'deploy', status: 'failed', message: null, created_at: NOW, finished_at: NOW, spec_version: null, error: { step: 'start', message: 'service web failed its health check within 1m0s', log_tail: ['[system] health check for web (http://127.0.0.1:20001/healthz): unhealthy after 1m0s (1 attempt(s), last: HTTP 404)'] } });
  c.services[0]!.restarts = 7;
  c.services[0]!.last_exit_code = 1;
  c.recent_errors.push({ ts: NOW, source: 'web', line: 'boom', deployment: 2 });
  c.auth = { enabled: true, providers: [{ name: 'github', status: 'ready' }, { name: 'google', status: 'not_configured' }], protect: [], login_url: '', users: 0 };
  c.variables.push({ name: 'OPENAI_API_KEY', value: null, secret: true, source: 'secret org/openai', resolved: false });
  c.database = { status: 'ready', branch: 'br', tables: [], migrations: [{ file: '0002_x.sql', status: 'pending', deployment: null, applied_at: null }] };
  const f = contextFindings(c);
  assert.deepEqual(f.map((x) => [x.id, x.severity]), [
    ['deploy_failed', 'error'],
    ['crash_loop', 'error'],
    ['secret_missing', 'error'],
    ['pending_migrations', 'warn'],
    ['auth_partial', 'info'],
  ]);
  assert.match(f[0]!.title, /#3 failed at start: web answers 404/);
  assert.equal(f[0]!.detail, '#2 is still serving');
  assert.deepEqual(f[1]!.evidence, ['boom']);
  for (const x of f) assert.ok(x.fix.length > 10);
});

test('a crash loop names its cause and shows the error line, not the end of a stack trace', () => {
  const c = base();
  c.services[0]!.state = 'restarting';
  c.services[0]!.restarts = 9;
  c.services[0]!.last_exit_code = 1;
  const trace = ['Error: STRIPE_KEY is not set', '    at Object.<anonymous> (/home/boxlite/app/server.js:3:9)', '    at Module._compile (node:internal/modules/cjs/loader:1554:14)', '    at Module.load (node:internal/modules/cjs/loader:1288:32)', '    at Function._load (node:internal/modules/cjs/loader:1104:12)', '    at node:internal/main/run_main_module:36:49', '', 'Node.js v22.11.0'];
  for (const line of trace) c.recent_errors.push({ ts: NOW, source: 'web', line, deployment: 2 });
  c.recent_errors.push({ ts: NOW, source: 'system', line: 'service web exited with code 1 after 40ms; restarting in 8s', deployment: 2 });
  const loop = contextFindings(c).find((f) => f.id === 'crash_loop')!;
  assert.match(loop.title, /web needs STRIPE_KEY/);
  assert.match(loop.fix, /secrets ref STRIPE_KEY/);
  assert.equal(loop.evidence![0], 'Error: STRIPE_KEY is not set');

  // An error the classifier has no rule for still leads with its error line.
  const other = base();
  other.services[0]!.restarts = 9;
  for (const line of ['node:events:486', '      throw er; // Unhandled error event', 'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000', '    at Server.setupListenHandle', "  code: 'EADDRINUSE',", "  port: 3000", '}', 'Node.js v24.8.0']) other.recent_errors.push({ ts: NOW, source: 'web', line, deployment: 2 });
  const generic = contextFindings(other).find((f) => f.id === 'crash_loop')!;
  assert.match(generic.title, /web restarted 9 times/);
  assert.equal(generic.evidence![0], 'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000');
});

test('a credential kept as a plain variable is pointed out, with the secret-store path', () => {
  const c = base();
  c.variables.push({ name: 'SLACK_TOKEN', value: 'xoxb-1', secret: false, source: 'online', resolved: true });
  c.variables.push({ name: 'LOG_LEVEL', value: 'info', secret: false, source: 'boxlite.toml', resolved: true });
  c.variables.push({ name: 'OPENAI_API_KEY', value: null, secret: true, source: 'secret org/openai', resolved: true });
  const f = contextFindings(c);
  assert.deepEqual(f.map((x) => [x.id, x.severity]), [['plain_credential', 'info']]);
  assert.match(f[0]!.title, /SLACK_TOKEN/);
  assert.doesNotMatch(f[0]!.title, /LOG_LEVEL|OPENAI/);
  assert.match(f[0]!.fix, /secrets set slack-token`, then `boxlite-app app secrets ref SLACK_TOKEN app\/slack-token/);
});

test('build warnings of the live deployment are findings next to a healthy app, not failures', () => {
  const lines = [
    '[build] added 212 packages, and audited 213 packages in 9s',
    '[build] 1 high severity vulnerability',
    '[build] (!) Some chunks are larger than 500 kB after minification. Consider:',
    '[build] npm warn deprecated inflight@1.0.6: This module is not supported',
  ];
  const ws = buildWarnings(lines);
  assert.deepEqual(ws.map((w) => w.id), ['npm_audit', 'large_bundle', 'deprecated_packages']);
  assert.deepEqual(buildWarnings(['added 212 packages, and audited 213 packages in 9s', 'found 0 vulnerabilities']), [], 'a clean install warns about nothing');
  assert.match(ws[0]!.title, /1 high severity vulnerability/);
  const c = base();
  c.build_warnings = ws;
  const f = contextFindings(c);
  assert.deepEqual(f.filter((x) => x.id.startsWith('build_')).map((x) => [x.id, x.severity]), [['build_npm_audit', 'warn'], ['build_large_bundle', 'info'], ['build_deprecated_packages', 'info']]);
});

test('a Box near its memory limit names the hungriest service and the next size; a nearly full disk names the cleanup', () => {
  const GiB = 1073741824;
  const c = base();
  c.services.push({ ...c.services[0]!, name: 'worker', exposed: false, memory_bytes: 300 * 1048576 });
  c.services[0]!.memory_bytes = 1500 * 1048576;
  c.box = { id: 'b1', state: 'running', usage: { memory_total_bytes: 2 * GiB, memory_available_bytes: 100 * 1048576, disk_total_bytes: 10 * GiB, disk_free_bytes: 0.5 * GiB } };
  const f = contextFindings(c);
  assert.deepEqual(f.map((x) => x.id), ['memory_low', 'disk_low']);
  assert.equal(f[0]!.title, 'the Box is nearly out of memory: 100.0 MB free of 2.00 GB; web uses 1.46 GB');
  assert.match(f[0]!.fix, /size = "medium"` under \[runtime\]/);
  assert.equal(f[1]!.title, 'the Box disk is nearly full: 512.0 MB free of 10.00 GB');

  // At the largest size there is no bigger Box to suggest; with room to spare, nothing is said.
  c.runtime = { image: 'node', size: 'large', build: [] };
  assert.doesNotMatch(contextFindings(c)[0]!.fix, /size =/);
  c.box.usage = { memory_total_bytes: 2 * GiB, memory_available_bytes: GiB, disk_total_bytes: 10 * GiB, disk_free_bytes: 5 * GiB };
  assert.deepEqual(contextFindings(c), []);
});
