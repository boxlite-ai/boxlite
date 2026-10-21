import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadIgnore, type IgnoreMatcher } from './ignore.js';
import type { UploadFile, UploadManifest } from './types.js';

const SECRET_NAME_RE = /^(\.env(\..*)?|.*\.pem|id_rsa.*|.*\.key)$/;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Walks the project, applies the ignore rules and hashes every included file. Paths are `/`-separated and sorted. */
export async function buildUploadManifest(projectDir: string, matcher?: IgnoreMatcher): Promise<UploadManifest> {
  const ig = matcher ?? (await loadIgnore(projectDir));
  const files: UploadFile[] = [];
  const excludedSecrets: string[] = [];
  const skipped: string[] = [];

  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(projectDir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped.push(relPath);
        continue;
      }
      if (entry.isDirectory()) {
        if (!ig.ignores(relPath, true)) await walk(relPath);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push(relPath);
        continue;
      }
      if (ig.ignores(relPath, false)) {
        if (SECRET_NAME_RE.test(entry.name)) excludedSecrets.push(relPath);
        continue;
      }
      const st = await lstat(join(projectDir, relPath));
      files.push({ path: relPath, size: st.size, mode: st.mode & 0o777, sha256: await sha256File(join(projectDir, relPath)) });
    }
  }

  await walk('');
  return { files, bytes: files.reduce((n, f) => n + f.size, 0), excludedSecrets, skipped };
}

export function isSecretFileName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}
