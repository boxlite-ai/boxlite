import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { exposedService, parseManifest } from './manifest.js';
import { readMigrations, type MigrationFile, type MigrationsRead } from './migrations.js';
import { MANIFEST_FILE, UPLOAD_MAX_BYTES, UPLOAD_WARN_BYTES, type CheckError, type CheckResult, type CheckWarning, type Manifest, type UploadManifest } from './types.js';
import { UPLOAD_SECRETS } from './redact.js';
import { buildUploadManifest } from './upload.js';

const SCAN_MAX_SIZE = 1024 * 1024;
const SCAN_HEAD = 64 * 1024;
const NODE_LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
const PYTHON_LOCKFILES = ['uv.lock', 'poetry.lock', 'pdm.lock', 'Pipfile.lock', 'requirements.txt'];

export interface CheckLocalOptions {
  /** Reuse an already computed upload manifest instead of walking the project again. */
  upload?: UploadManifest;
  /** Reuse an already read migrations directory. */
  migrations?: MigrationsRead;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function looksSecret(path: string, size: number): Promise<string | null> {
  if (size === 0 || size > SCAN_MAX_SIZE) return null;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, SCAN_HEAD));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.includes(0)) return null;
    const text = head.toString('utf8');
    for (const [re, what] of UPLOAD_SECRETS) if (re.test(text)) return what;
    return null;
  } finally {
    await fh.close();
  }
}

/** File-system checks that need the project directory: referenced paths, migrations, lockfile, upload size, secret-looking files. */
export async function checkLocal(projectDir: string, manifest: Manifest, options: CheckLocalOptions = {}): Promise<CheckResult> {
  const errors: CheckError[] = [];
  const warnings: CheckWarning[] = [];

  const exposed = exposedService(manifest);
  if (exposed?.static !== undefined) {
    if (!(await exists(join(projectDir, exposed.static)))) {
      if (manifest.runtime.build.length > 0) warnings.push({ rule: 'path_missing', message: `service "${exposed.name}": static path ${exposed.static} does not exist yet; it must be produced by runtime.build` });
      else errors.push({ file: MANIFEST_FILE, rule: 'path_missing', message: `service "${exposed.name}": static path ${exposed.static} does not exist` });
    }
  }

  if (manifest.database) {
    const migrations = options.migrations ?? (await readMigrations(projectDir, manifest));
    errors.push(...migrations.errors);
    if (!migrations.exists) warnings.push({ rule: 'path_missing', message: `[database] is set but ${manifest.database.migrations} does not exist; no migrations will run` });
  }

  const upload = options.upload ?? (await buildUploadManifest(projectDir));
  if (upload.bytes > UPLOAD_MAX_BYTES) errors.push({ file: 'project', rule: 'upload_too_large', message: `upload is ${formatBytes(upload.bytes)}; the limit is ${formatBytes(UPLOAD_MAX_BYTES)} (exclude files via .boxliteignore)` });
  else if (upload.bytes > UPLOAD_WARN_BYTES) warnings.push({ rule: 'upload_large', message: `upload is ${formatBytes(upload.bytes)} (${upload.files.length} files); consider excluding build output via .boxliteignore` });

  for (const f of upload.files) {
    const what = await looksSecret(join(projectDir, f.path), f.size);
    if (what) warnings.push({ rule: 'secret_file', message: `${f.path} looks like it contains ${what} and is not excluded; add it to .boxliteignore` });
  }
  for (const p of upload.excludedSecrets) warnings.push({ rule: 'secret_file', message: `${p} looks like a secret file (excluded)` });

  if (manifest.runtime.image === 'node' && (await exists(join(projectDir, 'package.json')))) {
    const locks = await Promise.all(NODE_LOCKFILES.map((n) => exists(join(projectDir, n))));
    if (!locks.some(Boolean)) warnings.push({ rule: 'no_lockfile', message: 'package.json has no lockfile; builds will not be reproducible (run npm install / pnpm install and commit the lockfile)' });
  }
  if (manifest.runtime.image === 'python' && (await exists(join(projectDir, 'pyproject.toml')))) {
    const locks = await Promise.all(PYTHON_LOCKFILES.map((n) => exists(join(projectDir, n))));
    if (!locks.some(Boolean)) warnings.push({ rule: 'no_lockfile', message: 'pyproject.toml has no lockfile (uv.lock, poetry.lock, pdm.lock or requirements.txt); builds will not be reproducible' });
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface ProjectCheck {
  result: CheckResult;
  manifest: Manifest | null;
  /** Raw boxlite.toml text, null when the file is missing. */
  source: string | null;
  upload: UploadManifest | null;
  migrations: MigrationFile[];
}

/** Reads boxlite.toml, parses it for `env`, and runs every local check. Never touches the network. */
export async function checkProject(projectDir: string, env: string): Promise<ProjectCheck> {
  let source: string;
  try {
    source = await readFile(join(projectDir, MANIFEST_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const result: CheckResult = { ok: false, errors: [{ file: MANIFEST_FILE, rule: 'missing_manifest', message: 'boxlite.toml not found; run `boxlite-app init`' }], warnings: [] };
    return { result, manifest: null, source: null, upload: null, migrations: [] };
  }
  const parsed = parseManifest(source, env);
  if (!parsed.manifest) {
    return { result: { ok: false, errors: parsed.errors, warnings: parsed.warnings }, manifest: null, source, upload: null, migrations: [] };
  }
  const upload = await buildUploadManifest(projectDir);
  const migrations = await readMigrations(projectDir, parsed.manifest);
  const local = await checkLocal(projectDir, parsed.manifest, { upload, migrations });
  const errors = [...parsed.errors, ...local.errors];
  return {
    result: { ok: errors.length === 0, errors, warnings: [...parsed.warnings, ...local.warnings] },
    manifest: parsed.manifest,
    source,
    upload,
    migrations: migrations.files,
  };
}
