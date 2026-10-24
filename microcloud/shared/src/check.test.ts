import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkLocal, checkProject } from './check.js';
import { createIgnore, loadIgnore } from './ignore.js';
import { parseManifest } from './manifest.js';
import { nextMigrationName, readMigrations } from './migrations.js';
import { buildUploadManifest } from './upload.js';

let dir: string;

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(dir, 'p-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  return root;
}

const BASE_TOML = 'name = "crm"\n[runtime]\nimage = "node"\n[[service]]\nname = "web"\ncommand = "node server.js"\nport = 3000\n';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'microcloud-shared-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('ignore: defaults, gitignore and boxliteignore re-includes', async () => {
  const root = await project({ '.gitignore': 'coverage/\n*.log\n', '.boxliteignore': '!dist/\nfixtures/\n' });
  const ig = await loadIgnore(root);
  assert.equal(ig.ignores('node_modules', true), true);
  assert.equal(ig.ignores('.git', true), true);
  assert.equal(ig.ignores('.env.local', false), true);
  assert.equal(ig.ignores('deploy/key.pem', false), true);
  assert.equal(ig.ignores('coverage', true), true);
  assert.equal(ig.ignores('app.log', false), true);
  assert.equal(ig.ignores('dist', true), false);
  assert.equal(ig.ignores('fixtures', true), true);
  assert.equal(ig.ignores('src/index.ts', false), false);
  const plain = createIgnore([['build/']]);
  assert.equal(plain.ignores('build', true), true);
  assert.equal(plain.ignores('build', false), false);
});

test('upload manifest hashes included files with mode and sorted paths', async () => {
  const root = await project({
    'boxlite.toml': BASE_TOML,
    'src/b.js': 'b',
    'src/a.js': 'a',
    'node_modules/x/index.js': 'nope',
    '.env.local': 'SECRET=1',
    'dist/out.js': 'built',
  });
  const up = await buildUploadManifest(root);
  assert.deepEqual(
    up.files.map((f) => f.path),
    ['boxlite.toml', 'src/a.js', 'src/b.js'],
  );
  const a = up.files.find((f) => f.path === 'src/a.js')!;
  assert.equal(a.sha256, 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  assert.equal(a.size, 1);
  assert.ok(a.mode >= 0o400 && a.mode <= 0o777);
  assert.equal(up.bytes, BASE_TOML.length + 2);
  assert.deepEqual(up.excludedSecrets, ['.env.local']);
});

test('checkProject passes a clean project and warns about missing lockfile and excluded secrets', async () => {
  const root = await project({ 'boxlite.toml': BASE_TOML, 'package.json': '{}', 'server.js': '', '.env': 'A=1' });
  const { result, manifest, upload } = await checkProject(root, 'main');
  assert.ok(manifest);
  assert.ok(upload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map((w) => w.rule).sort(), ['no_lockfile', 'secret_file']);
  assert.match(result.warnings.find((w) => w.rule === 'secret_file')!.message, /\.env looks like a secret file \(excluded\)/);
});

test('checkProject reports a missing boxlite.toml', async () => {
  const root = await project({});
  const { result } = await checkProject(root, 'main');
  assert.equal(result.ok, false);
  assert.equal(result.errors[0]?.rule, 'missing_manifest');
});

test('checkLocal flags secret-looking content, missing static dir, bad migrations', async () => {
  const toml = 'name = "crm"\n[runtime]\nimage = "node"\n[[service]]\nname = "site"\nstatic = "public/"\n[database]\n';
  const root = await project({
    'boxlite.toml': toml,
    'config/aws.txt': 'key=AKIAABCDEFGHIJKLMNOP',
    'keys/server.key': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
    'migrations/0001_init.sql': 'create table a();',
    'migrations/0001_again.sql': 'create table b();',
    'migrations/init.sql': 'x',
    'migrations/README.md': 'not sql',
  });
  const { manifest } = parseManifest(toml);
  assert.ok(manifest);
  const result = await checkLocal(root, manifest);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((e) => `${e.file}:${e.rule}`),
    ['boxlite.toml:path_missing', 'migrations/0001_init.sql:migration_duplicate', 'migrations/init.sql:migration_name'],
  );
  const secrets = result.warnings.filter((w) => w.rule === 'secret_file').map((w) => w.message);
  assert.equal(secrets.length, 2);
  assert.match(secrets[0]!, /config\/aws\.txt .*AWS access key/);
  assert.match(secrets[1]!, /keys\/server\.key .*private key and is not excluded/);
});

test('static path missing is only a warning when a build step will produce it', async () => {
  const toml = 'name = "crm"\n[runtime]\nimage = "node"\nbuild = ["npm run build"]\n[[service]]\nname = "site"\nstatic = "out/"\n';
  const root = await project({ 'boxlite.toml': toml });
  const { manifest } = parseManifest(toml);
  const result = await checkLocal(root, manifest!);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.find((w) => w.rule === 'path_missing')?.message.includes('out/'), true);
});

test('readMigrations returns files in number order with sha256 and sql', async () => {
  const toml = `${BASE_TOML}[database]\nmigrations = "db/migrations"\n`;
  const root = await project({ 'boxlite.toml': toml, 'db/migrations/0002_b.sql': 'b', 'db/migrations/0001_a.sql': 'a', 'db/migrations/00010_c.sql': 'c' });
  const { manifest } = parseManifest(toml);
  assert.equal(manifest?.database?.migrations, 'db/migrations/');
  const read = await readMigrations(root, manifest!);
  assert.equal(read.exists, true);
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.files.map((f) => f.file), ['0001_a.sql', '0002_b.sql', '00010_c.sql']);
  assert.equal(read.files[0]?.sql, 'a');
  assert.equal(read.files[0]?.sha256, 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  assert.equal(nextMigrationName(read.files, 'Add Deals!'), '0011_add_deals.sql');
  assert.equal(nextMigrationName([], 'init'), '0001_init.sql');
});
