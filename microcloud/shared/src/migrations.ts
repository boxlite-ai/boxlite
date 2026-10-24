import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIGRATION_FILE_RE, type CheckError, type Manifest } from './types.js';

/** One migration file as sent in the `migrations` field of `/plan` and `/deployments` bodies. */
export interface MigrationFile {
  file: string;
  sha256: string;
  sql: string;
}

export interface MigrationsRead {
  /** Directory relative to the project root (as in the manifest), or null when the manifest has no `[database]`. */
  dir: string | null;
  /** Well-named `.sql` files in name order. Empty when the directory does not exist. */
  files: MigrationFile[];
  exists: boolean;
  errors: CheckError[];
}

/**
 * Single reader for the migrations directory, shared by `check` (naming rules) and by the CLI
 * (`plan`/`apply`/`deploy` bodies). Only `NNNN_name.sql` files count; other `.sql` files are errors.
 */
export async function readMigrations(projectDir: string, manifest: Manifest): Promise<MigrationsRead> {
  if (!manifest.database) return { dir: null, files: [], exists: false, errors: [] };
  const dir = manifest.database.migrations;
  const errors: CheckError[] = [];
  let names: string[];
  try {
    names = (await readdir(join(projectDir, dir))).filter((n) => n.toLowerCase().endsWith('.sql')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { dir, files: [], exists: false, errors };
    throw e;
  }
  const seen = new Map<number, string>();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const m = MIGRATION_FILE_RE.exec(name);
    const file = `${dir}${name}`;
    if (!m) {
      errors.push({ file, rule: 'migration_name', message: `migration files must be named NNNN_name.sql (4+ digits): ${name}` });
      continue;
    }
    const n = Number(m[1]);
    const dup = seen.get(n);
    if (dup !== undefined) {
      errors.push({ file, rule: 'migration_duplicate', message: `migration number ${m[1]} is used by both ${dup} and ${name}` });
      continue;
    }
    seen.set(n, name);
    const sql = await readFile(join(projectDir, dir, name), 'utf8');
    files.push({ file: name, sha256: createHash('sha256').update(sql).digest('hex'), sql });
  }
  files.sort((a, b) => Number(MIGRATION_FILE_RE.exec(a.file)![1]) - Number(MIGRATION_FILE_RE.exec(b.file)![1]));
  return { dir, files, exists: true, errors };
}

/** Next migration file name, e.g. `0003_add_deals.sql` after `0002_*.sql`. */
export function nextMigrationName(existing: readonly MigrationFile[], name: string): string {
  const max = existing.reduce((n, f) => Math.max(n, Number(MIGRATION_FILE_RE.exec(f.file)?.[1] ?? 0)), 0);
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'migration';
  return `${String(max + 1).padStart(4, '0')}_${slug}.sql`;
}
