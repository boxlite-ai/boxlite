import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCron } from './cron.js';
import { lineOf, parseManifest } from './manifest.js';

const FULL = `name = "crm"
access = "org"

[runtime]
image = "node"
size = "small"
build = ["npm ci", "npm run build"]

[[service]]
name = "web"
command = "node server.js"
port = 3000

[[service]]
name = "worker"
command = "node worker.js"

[[schedule]]
name = "daily-summary"
cron = "0 9 * * *"
target = "web:/jobs/daily-summary"

[database]
migrations = "migrations/"

[[volume]]
name = "uploads"
mount = "/data/uploads"

[auth]
providers = ["google", "github"]
protect = ["/app/*"]

[domains]
custom = ["crm.acme.com"]

[variables]
LOG_LEVEL = "info"

[secrets]
OPENAI_API_KEY = "org/openai"

[env.staging]
runtime.size = "medium"
access = "private"

[env.staging.variables]
LOG_LEVEL = "debug"
`;

test('parses a full manifest into the spec shape', () => {
  const { manifest, errors, warnings } = parseManifest(FULL, 'main');
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.ok(manifest);
  assert.equal(manifest.app, 'crm');
  assert.equal(manifest.environment, 'main');
  assert.deepEqual(manifest.runtime, { image: 'node', size: 'small', build: ['npm ci', 'npm run build'], output: null });
  assert.deepEqual(manifest.services, [
    { name: 'web', command: 'node server.js', port: 3000, health: '/' },
    { name: 'worker', command: 'node worker.js' },
  ]);
  assert.deepEqual(manifest.schedules, [{ name: 'daily-summary', cron: '0 9 * * *', target: 'web:/jobs/daily-summary' }]);
  assert.deepEqual(manifest.database, { migrations: 'migrations/' });
  assert.deepEqual(manifest.volumes, [{ name: 'uploads', mount: '/data/uploads', mode: 'rw', from: null, path: null }]);
  assert.deepEqual(manifest.auth, { providers: ['google', 'github'], protect: ['/app/*'] });
  assert.deepEqual(manifest.domains, { builtin: 'crm', custom: ['crm.acme.com'] });
  assert.equal(manifest.access, 'org');
  assert.deepEqual(manifest.variables, { LOG_LEVEL: 'info' });
  assert.deepEqual(manifest.secrets, { OPENAI_API_KEY: 'org/openai' });
});

test('applies [env.<name>] overrides with dotted keys and nested tables', () => {
  const { manifest, errors } = parseManifest(FULL, 'staging');
  assert.deepEqual(errors, []);
  assert.ok(manifest);
  assert.equal(manifest.environment, 'staging');
  assert.equal(manifest.runtime.size, 'medium');
  assert.equal(manifest.runtime.image, 'node');
  assert.equal(manifest.access, 'private');
  assert.deepEqual(manifest.variables, { LOG_LEVEL: 'debug' });
  assert.equal(manifest.services.length, 2);
});

test('an env without overrides parses as the base manifest', () => {
  const { manifest } = parseManifest(FULL, 'preview');
  assert.equal(manifest?.environment, 'preview');
  assert.equal(manifest?.runtime.size, 'small');
});

test('minimal manifest gets defaults', () => {
  const { manifest, errors } = parseManifest('name = "x1"\n[runtime]\nimage = "python"\n[[service]]\nname = "web"\ncommand = "python app.py"\nport = 8000\n');
  assert.deepEqual(errors, []);
  assert.equal(manifest?.runtime.size, 'small');
  assert.equal(manifest?.access, 'private');
  assert.equal(manifest?.database, null);
  assert.equal(manifest?.auth, null);
  assert.deepEqual(manifest?.services[0], { name: 'web', command: 'python app.py', port: 8000, health: '/' });
});

test('reports unknown fields with the line number', () => {
  const src = 'name = "crm"\n\n[runtime]\nimage = "node"\nsiz = "small"\n\n[[service]]\nname = "web"\ncommand = "x"\nport = 3000\n';
  const { manifest, errors } = parseManifest(src);
  assert.equal(manifest, null);
  assert.deepEqual(errors, [{ file: 'boxlite.toml', line: 5, rule: 'unknown_field', message: 'unknown field "runtime.siz"' }]);
});

test('reports toml syntax errors with the line', () => {
  const { errors } = parseManifest('name = "crm"\n[runtime]\nimage = \n');
  assert.equal(errors[0]?.rule, 'toml_syntax');
  assert.equal(errors[0]?.line, 3);
});

test('enforces image, size, exposure, static and health rules', () => {
  const src = `name = "Crm"
[runtime]
image = "ruby"
size = "huge"
[[service]]
name = "web"
command = "x"
static = "dist/"
health = "healthz"
[[service]]
name = "web"
command = "y"
port = 70000
`;
  const { errors } = parseManifest(src);
  const rules = errors.map((e) => `${e.line}:${e.rule}`);
  assert.deepEqual(rules, [
    '1:invalid_name',
    '3:invalid_image',
    '4:invalid_size',
    '7:static_with_command',
    '9:invalid_health',
    '11:duplicate_service',
    '13:invalid_port',
  ]);
});

test('requires exactly one exposed service', () => {
  const none = parseManifest('name = "crm"\n[runtime]\nimage = "node"\n[[service]]\nname = "web"\ncommand = "x"\n');
  assert.equal(none.errors[0]?.rule, 'no_exposed_service');
  const two = parseManifest('name = "crm"\n[runtime]\nimage = "node"\n[[service]]\nname = "a"\ncommand = "x"\nport = 1\n[[service]]\nname = "b"\nstatic = "www/"\n');
  assert.equal(two.errors[0]?.rule, 'multiple_exposed_services');
  assert.equal(two.errors[0]?.line, 8);
});

test('validates schedules, cron and targets', () => {
  const src = `name = "crm"
[runtime]
image = "node"
[[service]]
name = "web"
command = "x"
port = 3000
[[service]]
name = "worker"
command = "y"
[[schedule]]
name = "a"
cron = "0 9 * *"
target = "web:/a"
[[schedule]]
name = "b"
cron = "*/5 * * * *"
target = "worker:/b"
[[schedule]]
name = "c"
cron = "0 0 1 jan mon-fri"
target = "nope"
`;
  const { errors } = parseManifest(src);
  assert.deepEqual(errors.map((e) => `${e.line}:${e.rule}`), ['13:invalid_cron', '18:invalid_schedule_target', '22:invalid_schedule_target']);
});

test('validates variables, secrets, auth, domains, access and volumes', () => {
  const src = `name = "crm"
access = "everyone"
[runtime]
image = "node"
[[service]]
name = "web"
command = "x"
port = 3000
[[volume]]
name = "v"
mount = "data"
mode = "rx"
[auth]
providers = ["twitter"]
[domains]
custom = ["not a host"]
[variables]
lower = "x"
LOG_LEVEL = 8080
[secrets]
KEY = "openai"
LOG_LEVEL = "org/x"
`;
  const { errors } = parseManifest(src);
  assert.deepEqual(errors.map((e) => `${e.line}:${e.rule}`), [
    '11:invalid_path',
    '12:invalid_volume_mode',
    '14:invalid_auth',
    '16:invalid_domain',
    '2:invalid_access',
    '18:invalid_variable',
    '21:invalid_secret_ref',
    '22:duplicate_variable',
  ]);
});

test('unknown fields inside [env.x] are reported even when another env is selected', () => {
  const src = 'name = "crm"\n[runtime]\nimage = "node"\n[[service]]\nname = "web"\ncommand = "x"\nport = 1\n[env.staging]\nbogus = 1\n';
  const { errors } = parseManifest(src, 'main');
  assert.deepEqual(errors, [{ file: 'boxlite.toml', line: 9, rule: 'unknown_field', message: 'unknown field "env.staging.bogus"' }]);
});

test('lineOf finds keys in the right array-of-tables entry', () => {
  const src = '[[service]]\nname = "a"\nport = 1\n[[service]]\nname = "b"\nport = 2\n';
  assert.equal(lineOf(src, ['service', 1, 'port']), 6);
  assert.equal(lineOf(src, ['service', 0, 'port']), 3);
  assert.equal(lineOf(src, ['service', 1]), 4);
  assert.equal(lineOf(src, ['service', 1, 'missing']), 4);
  assert.equal(lineOf('runtime.size = "x"\n', ['runtime', 'size']), 1);
  assert.equal(lineOf('[env.staging]\nruntime.size = "x"\n', ['env', 'staging', 'runtime', 'size']), 2);
  assert.equal(lineOf('', ['nothing']), undefined);
});

test('validateCron accepts common forms and rejects bad ones', () => {
  assert.equal(validateCron('0 9 * * *'), null);
  assert.equal(validateCron('*/15 0-6 1,15 jan-jun mon'), null);
  assert.match(validateCron('0 9 * *') ?? '', /5 fields/);
  assert.match(validateCron('60 * * * *') ?? '', /outside 0-59/);
  assert.match(validateCron('* * * * 8') ?? '', /outside 0-7/);
  assert.match(validateCron('*/0 * * * *') ?? '', /zero step/);
  assert.match(validateCron('5-1 * * * *') ?? '', /descending/);
});

test('the app name may be written as [app] name or top-level name, but not two different ones', () => {
  const body = '[runtime]\nimage = "node"\n[[service]]\nname = "web"\ncommand = "x"\nport = 3000\n';
  assert.equal(parseManifest(`[app]\nname = "crm"\n${body}`).manifest?.app, 'crm');
  assert.equal(parseManifest(`name = "crm"\n${body}`).manifest?.app, 'crm');
  assert.equal(parseManifest(`name = "crm"\n[app]\nname = "crm"\n${body}`).manifest?.app, 'crm');
  const conflict = parseManifest(`name = "crm"\n[app]\nname = "other"\n${body}`);
  assert.equal(conflict.manifest, null);
  assert.deepEqual(conflict.errors.map((e) => [e.rule, e.line]), [['conflicting_name', 1]]);
  const missing = parseManifest(body);
  assert.deepEqual(missing.errors.map((e) => e.rule), ['missing_field']);
  assert.match(missing.errors[0]!.message, /\[app\] name is required/);
  const unknown = parseManifest(`[app]\nname = "crm"\ntitle = "CRM"\n${body}`);
  assert.deepEqual(unknown.errors.map((e) => [e.rule, e.line]), [['unknown_field', 3]]);
});

test('every boxlite.toml example in agent/SKILL.md parses', async () => {
  const { readFile } = await import('node:fs/promises');
  const skill = await readFile(new URL('../../agent/SKILL.md', import.meta.url), 'utf8');
  const blocks = [...skill.matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  assert.ok(blocks.length > 0, 'SKILL.md has no toml examples');
  for (const block of blocks) {
    const out = parseManifest(block);
    assert.deepEqual(out.errors, [], `SKILL.md example failed to parse:\n${block}`);
  }
});

test('variables and secrets may not take the names the platform sets (DATABASE_URL, PORT, BOXLITE_*)', () => {
  const src = `name = "crm"
[runtime]
image = "node"
[[service]]
name = "web"
command = "x"
port = 3000
[variables]
PORT = "8080"
BOXLITE_APP_URL = "https://elsewhere"
PORTAL = "ok"
[secrets]
DATABASE_URL = "org/db"
[env.staging.variables]
BOXLITE_ENV = "prod"
`;
  const main = parseManifest(src);
  assert.equal(main.manifest, null);
  assert.deepEqual(main.errors.map((e) => `${e.line}:${e.rule}`), ['9:reserved_variable', '10:reserved_variable', '13:reserved_variable']);
  assert.match(main.errors[0]!.message, /PORT is set by BoxLite/);
  // [env.<name>] overrides are checked for the env they resolve to.
  assert.deepEqual(parseManifest(src, 'staging').errors.map((e) => e.rule), ['reserved_variable', 'reserved_variable', 'reserved_variable', 'reserved_variable']);
  const ok = parseManifest(src.replace(/^(PORT|BOXLITE_APP_URL) = .*\n/gm, '').replace(/\[secrets\]\nDATABASE_URL = .*\n/, '').replace(/\[env\.staging[\s\S]*/, ''));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.manifest?.variables, { PORTAL: 'ok' });
});

test('public_paths open single paths of a private app; the whole app only through access', () => {
  const toml = (paths: string) => `public_paths = [${paths}]\n[app]\nname = "crm"\n[runtime]\nimage = "node"\n[[service]]\nname = "web"\ncommand = "node s.js"\nport = 3000\n`;
  const ok = parseManifest(toml('"/webhooks/*"'));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.manifest?.public_paths, ['/webhooks/*']);
  for (const bad of ['"/*"', '"/"', '"webhooks/*"']) {
    const r = parseManifest(toml(bad));
    assert.ok(r.errors.some((e) => String(e.path ?? e.message).includes('public_paths') || e.message.includes('public_paths')), `${bad}: ${JSON.stringify(r.errors)}`);
  }
});
