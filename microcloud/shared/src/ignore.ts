import ignore from 'ignore';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default upload excludes (PRD 2.4). `.gitignore` then `.boxliteignore` are layered on top, so `!` lines in them re-include. */
export const DEFAULT_IGNORES: readonly string[] = [
  '.git/',
  '.boxlite/',
  '.env*',
  'node_modules/',
  '.venv/',
  '__pycache__/',
  'dist/',
  'build/',
  '.next/',
  '*.pem',
  'id_rsa*',
];

export const IGNORE_FILES = ['.gitignore', '.boxliteignore'] as const;

export interface IgnoreMatcher {
  /** `relPath` uses `/` separators and is relative to the project root. */
  ignores(relPath: string, isDir: boolean): boolean;
  /** Patterns in effect, in order of precedence (later wins). */
  patterns: string[];
}

export function createIgnore(layers: readonly (readonly string[])[]): IgnoreMatcher {
  const patterns = layers.flat().map((p) => p.trim()).filter((p) => p !== '' && !p.startsWith('#'));
  const ig = ignore().add(patterns);
  return {
    patterns,
    ignores(relPath, isDir) {
      const p = isDir && !relPath.endsWith('/') ? `${relPath}/` : relPath;
      return ig.ignores(p);
    },
  };
}

/** Reads the project's `.gitignore` and `.boxliteignore` (root only) and layers them over the defaults. */
export async function loadIgnore(projectDir: string): Promise<IgnoreMatcher> {
  const layers: string[][] = [[...DEFAULT_IGNORES]];
  for (const name of IGNORE_FILES) {
    try {
      layers.push((await readFile(join(projectDir, name), 'utf8')).split(/\r?\n/));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return createIgnore(layers);
}
