import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** API origin listener (/v1, /sv, /admin, /auth, …). */
  port: number;
  /** The CP's API origin (no trailing slash), the tunnel to `port`. Becomes BOXLITE_CP_URL in Boxes. */
  publicUrl: string;
  /** Console origin listener; its tunnel is registered at boot (origins.ts). Default port + 1. */
  consolePort?: number;
  /** The BoxLite Box the CP runs in; every app env origin is a tunnel to one of its ports. */
  cpBoxId?: string;
  /** Ports handed to app envs, one origin each. Default 10001–10999. */
  envPorts?: { min: number; max: number };
  dataDir: string;
  adminToken: string;
  /** HMAC key for the app-proxy access cookie, the console session and the OAuth `state`. */
  sessionSecret: string;
  boxliteApiUrl: string;
  boxliteApiKey: string;
  neonApiKey: string;
  neonOrgId: string;
  neonRegion: string;
  svBinDir: string;
  agentMdPath: string;
  cliTgzPath: string;
  /** The built console (deploy/build-console.sh). Default ../console-dist. */
  consoleDir?: string;
  /** The App hand-off prompt; default prompt-template.md next to agentMdPath. */
  promptTemplatePath?: string;
  /** End-user sign-in: OAuth client credentials per provider; a provider without them is skipped. */
  oauth?: Partial<Record<string, { clientId: string; clientSecret: string }>>;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root: both src/config.ts (tsx) and dist/server.mjs (bundle) sit two levels below it. */
const repoRoot = resolve(here, '..', '..');

/**
 * Dev convenience: read KEY=VALUE pairs from the repo's .env.local without overriding the real env.
 * BOXLITE_API_URL is only taken when it points at a /v1 REST base: older files carry the console
 * API base (`…/api`), while the /v1 REST surface the CP uses lives on api.dev.boxlite.ai.
 */
export function loadDotEnvLocal(file = join(repoRoot, '.env.local'), env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key === 'BOXLITE_API_URL' && !/\/v1\/?$/.test(value)) continue;
    if (env[key] === undefined) env[key] = value;
  }
}

/** Reads a secret from env, else from DATA_DIR/<file>, else generates and persists one (value never logged). */
function persistentSecret(dataDir: string, envValue: string | undefined, file: string): string {
  if (envValue) return envValue;
  const path = join(dataDir, file);
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const value = randomBytes(24).toString('base64url');
  writeFileSync(path, value + '\n', { mode: 0o600 });
  console.log(`[config] generated ${file} at ${path}`);
  return value;
}

/** `<PROVIDER>_CLIENT_ID` + `<PROVIDER>_CLIENT_SECRET`, e.g. GITHUB_CLIENT_ID. */
function oauthFromEnv(env: NodeJS.ProcessEnv): Config['oauth'] {
  const out: NonNullable<Config['oauth']> = {};
  for (const name of ['github', 'google']) {
    const id = env[`${name.toUpperCase()}_CLIENT_ID`];
    const secret = env[`${name.toUpperCase()}_CLIENT_SECRET`];
    if (id && secret) out[name] = { clientId: id, clientSecret: secret };
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  // Relative defaults resolve against the working directory (run from control-plane/ in dev).
  const dataDir = resolve(env.DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  return {
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    consolePort: Number(env.CONSOLE_PORT ?? port + 1),
    cpBoxId: env.CP_BOX_ID || 'microcloud-cp',
    envPorts: { min: Number(env.ENV_PORT_MIN ?? 10001), max: Number(env.ENV_PORT_MAX ?? 10999) },
    dataDir,
    adminToken: persistentSecret(dataDir, env.ADMIN_TOKEN, 'admin_token'),
    sessionSecret: persistentSecret(dataDir, env.SESSION_SECRET, 'session_secret'),
    boxliteApiUrl: (env.BOXLITE_API_URL ?? 'https://api.dev.boxlite.ai/v1').replace(/\/+$/, ''),
    boxliteApiKey: env.BOXLITE_API_KEY ?? '',
    neonApiKey: env.NEON_API_KEY ?? '',
    neonOrgId: env.NEON_ORG_ID ?? '',
    neonRegion: env.NEON_REGION ?? 'aws-us-east-2',
    svBinDir: resolve(env.SV_BIN_DIR ?? '../supervisor/bin'),
    agentMdPath: resolve(env.AGENT_MD_PATH ?? '../agent/SKILL.md'),
    cliTgzPath: resolve(env.CLI_TGZ_PATH ?? '../cli/boxlite-app.tgz'),
    consoleDir: resolve(env.CONSOLE_DIR ?? '../console-dist'),
    ...(env.PROMPT_TEMPLATE_PATH ? { promptTemplatePath: resolve(env.PROMPT_TEMPLATE_PATH) } : {}),
    oauth: oauthFromEnv(env),
  };
}
