import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseManifest } from '@microcloud/shared';
import { buildSpec, classifyMigrations, diffSpecs, onlineChecks } from '../src/spec.js';
import { TOML } from './helpers.js';

const manifest = (toml = TOML) => {
  const out = parseManifest(toml, 'main');
  assert.deepEqual(out.errors, []);
  return out.manifest!;
};

const specOf = (toml: string) =>
  buildSpec({ manifest: manifest(toml), version: 1, deployment: 1, baseVersion: 0, applied: [], accessOverride: null, assigned: { box_id: null, box_url: null, db_host: null, db_branch: null, app_url: 'https://cp.test/crm' } });

test('first plan lists every section as added', () => {
  const changes = diffSpecs(undefined, manifest());
  const paths = changes.map((c) => `${c.kind} ${c.path}`);
  assert.ok(paths.includes('+ runtime'));
  assert.ok(paths.includes('+ service.web'));
  assert.ok(paths.includes('+ access'));
});

test('diff reports ~, + and - per field', () => {
  const prev = specOf(TOML + '\n[variables]\nLOG_LEVEL = "info"\nOLD = "x"\n');
  const next = manifest(
    TOML.replace('size = "small"', 'size = "medium"').replace('node server.js', 'node app.js') +
      '\n[[service]]\nname = "worker"\ncommand = "node worker.js"\n\n[database]\nmigrations = "migrations/"\n\n[variables]\nLOG_LEVEL = "debug"\nNEW = "y"\n',
  );
  const got = diffSpecs(prev, next).map((c) => `${c.kind} ${c.path}`);
  assert.deepEqual(got.sort(), ['+ database', '+ service.worker', '+ variables.NEW', '- variables.OLD', '~ runtime.size', '~ service.web.command', '~ variables.LOG_LEVEL'].sort());
});

test('an online access override is online_only', () => {
  const prev = specOf(TOML);
  const changes = diffSpecs(prev, manifest(), { accessOverride: 'public' });
  assert.deepEqual(changes, [{ kind: 'online_only', path: 'access', from: 'private', to: 'public' }]);
});

test('spec carries the integer port from boxlite.toml', () => {
  assert.equal(specOf(TOML).services[0]!.port, 3000);
});

test('classifyMigrations separates pending, applied and changed', () => {
  const out = classifyMigrations(
    [
      { file: '0002_b.sql', sha256: 'b' },
      { file: '0001_a.sql', sha256: 'a' },
      { file: '0003_c.sql', sha256: 'c' },
    ],
    [
      { file: '0001_a.sql', sha256: 'a' },
      { file: '0002_b.sql', sha256: 'other' },
    ],
  );
  assert.deepEqual(out, { pending: ['0003_c.sql'], changed: ['0002_b.sql'], applied: ['0001_a.sql'] });
});

test('online checks: unsupported volume source and unknown secret', () => {
  const m = manifest(TOML + '\n[[volume]]\nname = "up"\nmount = "/data/up"\nfrom = "main"\n\n[secrets]\nOPENAI_API_KEY = "org/openai"\n');
  const { errors } = onlineChecks(m, { appName: 'crm', envName: 'main', secretExists: () => false });
  const rules = errors.map((e) => e.rule).sort();
  assert.ok(rules.includes('secret_not_found'), JSON.stringify(errors));
  assert.ok(rules.includes('not_supported_yet'), JSON.stringify(errors));
});

test('online checks: a custom domain is refused until the platform can serve it, saying where the app is', () => {
  const m = manifest(TOML + '\n[domains]\ncustom = ["crm.acme.com"]\n');
  const { errors } = onlineChecks(m, { appName: 'crm', envName: 'main', secretExists: () => true });
  const e = errors.find((x) => x.rule === 'not_supported_yet');
  assert.ok(e, JSON.stringify(errors));
  assert.match(e.message, /crm\.acme\.com/);
  assert.match(e.message, /remove \[domains\]/);
  assert.deepEqual(onlineChecks(manifest(TOML), { appName: 'crm', envName: 'main', secretExists: () => true }).errors, []);
});
