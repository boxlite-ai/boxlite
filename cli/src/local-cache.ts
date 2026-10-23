/**
 * Per-project cache in .boxlite/cache.json (git-ignored with .boxlite/), so `app curl` does not ask
 * the control plane the same things on every call: an environment's URL, and a test session while
 * it is still good. Written only in a linked project; anything unreadable is simply a miss.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Cache {
  /** By `<api url>|<app>|<env>`; `sig` ties the URL to the App key, so a planted file never receives the key. */
  urls: Record<string, { url: string; sig: string }>;
  sessions: Record<string, { cookie: string; email: string; expires_at: string }>;
}

const file = (cwd: string) => join(cwd, '.boxlite', 'cache.json');

async function load(cwd: string): Promise<Cache> {
  try {
    const c = JSON.parse(await readFile(file(cwd), 'utf8')) as Partial<Cache>;
    return { urls: c.urls ?? {}, sessions: c.sessions ?? {} };
  } catch {
    return { urls: {}, sessions: {} };
  }
}

async function save(cwd: string, c: Cache): Promise<void> {
  if (!existsSync(join(cwd, '.boxlite'))) return;
  await writeFile(file(cwd), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
}

export interface UrlScope {
  apiUrl: string;
  app: string;
  env: string;
  /** The App key: only a URL cached with it is trusted with it. */
  key: string;
}

const urlId = (s: UrlScope) => `${s.apiUrl.replace(/\/+$/, '')}|${s.app}|${s.env}`;
const urlSig = (s: UrlScope, url: string) => createHash('sha256').update(`${s.key}|${urlId(s)}|${url}`).digest('hex');

/** The environment URL cached for this control plane, App and key; anything else is a miss. */
export async function cachedUrl(cwd: string, scope: UrlScope): Promise<string | undefined> {
  const e = (await load(cwd)).urls[urlId(scope)];
  return e && typeof e === 'object' && e.url && e.sig === urlSig(scope, e.url) ? e.url : undefined;
}

export async function rememberUrl(cwd: string, scope: UrlScope, url: string | null): Promise<void> {
  const c = await load(cwd);
  if (url) c.urls[urlId(scope)] = { url, sig: urlSig(scope, url) };
  else delete c.urls[urlId(scope)];
  await save(cwd, c);
}

const sessionKey = (env: string, email: string, role: string) => `${env}|${email.toLowerCase()}|${role}`;

/** A test session that still has more than a minute to live. */
export async function cachedSession(cwd: string, env: string, email: string, role: string): Promise<{ cookie: string; email: string; expires_at: string } | undefined> {
  const s = (await load(cwd)).sessions[sessionKey(env, email, role)];
  return s && Date.parse(s.expires_at) - Date.now() > 60_000 ? s : undefined;
}

export async function rememberSession(cwd: string, env: string, email: string, role: string, s: { cookie: string; email: string; expires_at: string }): Promise<void> {
  const c = await load(cwd);
  c.sessions[sessionKey(env, email, role)] = s;
  await save(cwd, c);
}

/** After test users are removed, their cached sessions are gone too. */
export async function forgetSessions(cwd: string, env: string): Promise<void> {
  const c = await load(cwd);
  for (const k of Object.keys(c.sessions)) if (k.startsWith(`${env}|`)) delete c.sessions[k];
  await save(cwd, c);
}
