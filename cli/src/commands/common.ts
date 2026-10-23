import { checkProject, MicrocloudError, type CheckResult, type Manifest, type MigrationFile, type UploadManifest } from '@microcloud/shared';
import type { PlanRequest } from '../api.js';
import type { Ctx } from '../context.js';
import { checkLines, formatBytes } from '../output.js';

export interface CheckedProject {
  manifest: Manifest;
  upload: UploadManifest;
  migrations: MigrationFile[];
  result: CheckResult;
  source: string;
}

export function invalidManifestError(result: CheckResult, printed = false): MicrocloudError {
  const n = result.errors.length;
  const first = result.errors[0];
  const where = first ? `${first.file}${first.line !== undefined ? `:${first.line}` : ''}` : 'boxlite.toml';
  return new MicrocloudError('invalid_manifest', `${n} error${n === 1 ? '' : 's'} in the project${first ? ` (first: ${where} ${first.rule})` : ''}`, `fix ${where}: ${first?.message ?? 'see errors'}; then \`boxlite-app check\``, {
    errors: result.errors,
    warnings: result.warnings,
    ...(printed ? { printed: true } : {}),
  });
}

/** Runs the local checks; prints warnings, and throws `invalid_manifest` (exit 7) on errors. */
export async function requireCheck(ctx: Ctx): Promise<CheckedProject> {
  const checked = await checkProject(ctx.cwd, ctx.envName);
  if (!checked.result.ok || !checked.manifest || !checked.upload || checked.source === null) {
    if (!ctx.json) for (const line of checkLines(checked.result)) ctx.out.line(line);
    throw invalidManifestError(checked.result, !ctx.json);
  }
  for (const w of checked.result.warnings) ctx.out.note(`warning  ${w.rule}  ${w.message}`);
  return { manifest: checked.manifest, upload: checked.upload, migrations: checked.migrations, result: checked.result, source: checked.source };
}

/** The local project when it is valid, else null; for commands that only use it to sharpen output. */
export async function readLocalProject(ctx: Ctx): Promise<CheckedProject | null> {
  try {
    const checked = await checkProject(ctx.cwd, ctx.envName);
    if (!checked.manifest || !checked.upload || checked.source === null) return null;
    return { manifest: checked.manifest, upload: checked.upload, migrations: checked.migrations, result: checked.result, source: checked.source };
  } catch {
    return null;
  }
}

export function planRequest(ctx: Ctx, checked: CheckedProject, force = false): PlanRequest & { force?: boolean } {
  return {
    manifest: checked.manifest,
    base_version: ctx.baseVersion,
    migrations: checked.migrations,
    upload: { files: checked.upload.files.length, bytes: checked.upload.bytes, warnings: checked.result.warnings.map((w) => w.message) },
    ...(force ? { force } : {}),
  };
}

/** `42 files, 1.3 MB · warning: .env.local looks like a secret file (excluded)` */
/** What a deploy would upload: the files the platform does not have yet, out of the whole snapshot. */
export interface CodeDiff {
  files: number;
  bytes: number;
  new_files: number;
  new_bytes: number;
}

export async function codeDiff(ctx: Ctx, checked: CheckedProject): Promise<CodeDiff> {
  const { missing } = await (await ctx.appApi()).createUpload(checked.upload.files);
  const need = new Set(missing);
  const fresh = checked.upload.files.filter((f) => need.has(f.sha256));
  const newBytes = [...new Map(fresh.map((f) => [f.sha256, f.size])).values()].reduce((n, b) => n + b, 0);
  return { files: checked.upload.files.length, bytes: checked.upload.bytes, new_files: fresh.length, new_bytes: newBytes };
}

export function uploadSummary(checked: CheckedProject): string {
  const secrets = checked.result.warnings.filter((w) => w.rule === 'secret_file').map((w) => w.message);
  let text = `${checked.upload.files.length} files, ${formatBytes(checked.upload.bytes)}`;
  for (const s of secrets) text += ` · warning: ${s}`;
  return text;
}

export function parseInteger(text: string, what: string): number {
  if (!/^\d+$/.test(text)) throw new MicrocloudError('usage', `${what} must be a number (got "${text}")`, `pass a whole number, e.g. ${what.startsWith('-') ? `${what} 20` : '7'}`);
  return Number(text);
}

/** Everything piped in on stdin, as text. */
export async function readStdin(ctx: Ctx): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of ctx.io.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}
