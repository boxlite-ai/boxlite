/**
 * The next step for a deployment refused by its checks: what to do about the first problem, not
 * "run check" (the agent already has the errors; it needs the action). Rules without a specific
 * step get the problem itself, with the file and line where it is.
 */
import type { CheckError } from '@microcloud/shared';

const BY_RULE: Record<string, (e: CheckError) => string> = {
  migration_changed: (e) =>
    `put ${e.file} back exactly as it was applied (e.g. \`git checkout -- ${e.file}\`) and move your change into a new migration: \`boxlite-app app db migration new <name>\`; then \`boxlite-app deploy\``,
  stale_base: () => 'the environment changed since your last deploy: `boxlite-app app pull` brings boxlite.toml up to date (your file is kept as boxlite.toml.bak); merge your edits, then `boxlite-app deploy`',
  secret_not_found: (e) => `${e.message}; then \`boxlite-app deploy\``,
};

export function checkFailedNext(errors: readonly CheckError[]): string {
  const first = errors[0];
  if (!first) return 'run `boxlite-app check` and fix the errors';
  const specific = BY_RULE[first.rule]?.(first);
  if (specific) return specific;
  const where = first.file ? `${first.file}${first.line !== undefined ? `:${first.line}` : ''}` : 'boxlite.toml';
  return `fix ${where}: ${first.message}; \`boxlite-app check\` shows every problem${errors.length > 1 ? ` (${errors.length} in all)` : ''}`;
}
