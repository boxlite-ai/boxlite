import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextFindings, type AgentContext } from './agent-context.js';

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
