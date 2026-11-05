/**
 * Saved organization API keys (`boxlite-app login`), so the user enters the key once instead of exporting
 * it in every shell: ~/.config/boxlite-app/credentials.json ($BOXLITE_CONFIG_DIR or
 * $XDG_CONFIG_HOME/boxlite-app), readable by the user only. BOXLITE_API_KEY, when set, still wins.
 * The project link selects the organization through its API URL.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SavedKey {
  api_url: string
  key: string
  saved_at: string
}

interface CredentialsFile {
  /** By organization API URL. */
  profiles: Record<string, SavedKey>
}

/** From the environment the CLI runs with only (no HOME: no saved keys), so a test's env never reads the real file. */
export function credentialsPath(env: NodeJS.ProcessEnv): string | null {
  const base =
    env.BOXLITE_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, 'boxlite-app')
      : env.HOME
        ? join(env.HOME, '.config', 'boxlite-app')
        : null)
  return base ? join(base, 'credentials.json') : null
}

const id = (apiUrl: string) => apiUrl.replace(/\/+$/, '')

function read(env: NodeJS.ProcessEnv): CredentialsFile {
  const path = credentialsPath(env)
  if (!path) return { profiles: {} }
  try {
    const f = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialsFile>
    return { profiles: f.profiles ?? {} }
  } catch {
    return { profiles: {} }
  }
}

function write(env: NodeJS.ProcessEnv, f: CredentialsFile): string {
  const path = credentialsPath(env)
  if (!path) throw new Error('no place to save the key: set HOME or BOXLITE_CONFIG_DIR')
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

/** Without an API URL, select a profile only when one organization is saved. */
export function savedKey(env: NodeJS.ProcessEnv, apiUrl?: string): SavedKey | undefined {
  const f = read(env)
  if (apiUrl) return f.profiles[id(apiUrl)]
  const candidates = Object.values(f.profiles)
  return candidates.length === 1 ? candidates[0] : undefined
}

export function saveKey(env: NodeJS.ProcessEnv, k: Omit<SavedKey, 'saved_at'>): string {
  const f = read(env)
  const apiUrl = id(k.api_url)
  f.profiles[apiUrl] = { ...k, api_url: apiUrl, saved_at: new Date().toISOString() }
  return write(env, f)
}

/** Forget the organization credential, or all credentials when no API URL is given. */
export function forgetKey(env: NodeJS.ProcessEnv, apiUrl?: string): boolean {
  const f = read(env)
  if (!apiUrl) {
    const path = credentialsPath(env)
    if (path) rmSync(path, { force: true })
    return Object.keys(f.profiles).length > 0
  }
  const profile = id(apiUrl)
  if (!f.profiles[profile]) return false
  delete f.profiles[profile]
  write(env, f)
  return true
}
