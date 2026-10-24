import { createHash } from 'node:crypto';
import type { MigrationFile } from './db.js';
import { fail } from './errors.js';

/** contracts §0: `NNNN_name.sql`, 4+ digits. */
export const MIGRATION_FILE_RE_CP = /^(\d{4,})_[A-Za-z0-9_-]+\.sql$/;

/**
 * Validates migration files sent inline with plan/apply/deploy: names follow the rule, are unique,
 * and each sha256 really is the hash of its SQL (the sha is what pins an applied file forever).
 */
export function validateMigrationFiles(files: MigrationFile[]): MigrationFile[] {
  const seen = new Set<string>();
  const errors: { file: string; rule: string; message: string }[] = [];
  for (const m of files) {
    if (!MIGRATION_FILE_RE_CP.test(m.file)) errors.push({ file: m.file, rule: 'migration_name', message: `${m.file}: migration files are named NNNN_name.sql` });
    if (seen.has(m.file)) errors.push({ file: m.file, rule: 'migration_duplicate', message: `${m.file} is listed twice` });
    seen.add(m.file);
    const sha = createHash('sha256').update(m.sql, 'utf8').digest('hex');
    if (sha !== m.sha256) errors.push({ file: m.file, rule: 'migration_sha256', message: `${m.file}: sha256 does not match its sql` });
  }
  if (errors.length) throw fail('invalid_manifest', `invalid migrations: ${errors.map((e) => e.message).join('; ')}`, 'run `boxlite-app check`', { errors });
  return [...files].sort((a, b) => a.file.localeCompare(b.file));
}
