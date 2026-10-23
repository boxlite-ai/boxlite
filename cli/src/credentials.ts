/**
 * Saved App keys (`boxlite-app login`), so an agent hands the CLI the key once instead of exporting
 * it in every shell: ~/.config/boxlite-app/credentials.json ($BOXLITE_CONFIG_DIR or
 * $XDG_CONFIG_HOME/boxlite-app), readable by the user only. BOXLITE_API_KEY, when set, still wins.
 * Several agents may share the file: a key is only picked for the App the folder or command names.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SavedKey {
  api_url: string;
  app: string;
  key: string;
  saved_at: string;
}

interface CredentialsFile {
  /** By `<api_url>|<app>`. */
  profiles: Record<string, SavedKey>;
}

/** From the environment the CLI runs with only (no HOME: no saved keys), so a test's env never reads the real file. */
export function credentialsPath(env: NodeJS.ProcessEnv): string | null {
  const base = env.BOXLITE_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'boxlite-app') : env.HOME ? join(env.HOME, '.config', 'boxlite-app') : null);
  return base ? join(base, 'credentials.json') : null;
}

const id = (apiUrl: string, app: string) => `${apiUrl.replace(/\/+$/, '')}|${app}`;

function read(env: NodeJS.ProcessEnv): CredentialsFile {
  const path = credentialsPath(env);
  if (!path) return { profiles: {} };
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialsFile>;
    return { profiles: f.profiles ?? {} };
  } catch {
    return { profiles: {} };
  }
}

function write(env: NodeJS.ProcessEnv, f: CredentialsFile): string {
  const path = credentialsPath(env);
  if (!path) throw new Error('no place to save the key: set HOME or BOXLITE_CONFIG_DIR');
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const matching = (f: CredentialsFile, apiUrl: string | undefined, app: string | undefined) =>
  Object.values(f.profiles).filter((p) => (!apiUrl || id(apiUrl, p.app) === id(p.api_url, p.app)) && (!app || p.app === app));

/**
 * The saved key for this App on this control plane. Without an App only a single saved key
 * qualifies: with several, guessing (say, the last login) would let one agent act on another
 * agent's App, so the caller has to name it (savedApps lists the choices).
 */
export function savedKey(env: NodeJS.ProcessEnv, apiUrl: string | undefined, app: string | undefined): SavedKey | undefined {
  const f = read(env);
  if (apiUrl && app) return f.profiles[id(apiUrl, app)];
  const candidates = matching(f, apiUrl, app);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The Apps with a saved key (on this control plane, when given). */
export function savedApps(env: NodeJS.ProcessEnv, apiUrl: string | undefined): string[] {
  return matching(read(env), apiUrl, undefined).map((p) => p.app).sort();
}

export function saveKey(env: NodeJS.ProcessEnv, k: Omit<SavedKey, 'saved_at'>): string {
  const f = read(env);
  const pid = id(k.api_url, k.app);
  f.profiles[pid] = { ...k, api_url: k.api_url.replace(/\/+$/, ''), saved_at: new Date().toISOString() };
  return write(env, f);
}

/** Forgets the saved key of one App (or every one); true when something was removed. */
export function forgetKey(env: NodeJS.ProcessEnv, apiUrl: string | undefined, app: string | undefined): boolean {
  const f = read(env);
  const before = Object.keys(f.profiles).length;
  if (!apiUrl && !app) {
    const path = credentialsPath(env);
    if (path) rmSync(path, { force: true });
    return before > 0;
  }
  for (const [pid, p] of Object.entries(f.profiles)) {
    if ((!apiUrl || id(apiUrl, p.app) === pid) && (!app || p.app === app)) delete f.profiles[pid];
  }
  write(env, f);
  return Object.keys(f.profiles).length < before;
}
