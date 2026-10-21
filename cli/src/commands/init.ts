import { MANIFEST_FILE, MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakeCtx } from '../cli.js';
import { LINK_FILE, writeLink, type Ctx } from '../context.js';
import { describe } from '../meta.js';

const GITIGNORE_LINES = ['.boxlite/', '.env.local'];

export function manifestSkeleton(app: string): string {
  return `# boxlite.toml — manifest for the BoxLite Micro-cloud App "${app}".
# Edit, then run \`boxlite-app check\`; \`boxlite-app docs manifest\` explains every field.
[app]
name = "${app}"

[runtime]
image = "node"            # base | python | node
size = "small"            # nano | small | medium | large
build = []                # commands run on the Box after upload, e.g. ["npm ci", "npm run build"]

[[service]]
name = "web"
command = "npm start"     # must listen on $PORT (the platform sets it)
port = 3000               # marks this service as the exposed one; the value is only a hint
health = "/"              # must answer 2xx within 60 s after start

# End-user sign-in, hosted by the platform: send users to .boxlite/auth/login and read
# X-BoxLite-User-* headers. \`protect\` paths require login. Remove [auth] for an anonymous site.
# Sign-in does not open a private app to others: that is the access level (\`boxlite-app app access\`).
[auth]
providers = ["github", "google"]
# protect = ["/app/*"]

# Postgres (Neon). Uncomment to provision a database; files in migrations/ named
# NNNN_name.sql run in order on every deploy. DATABASE_URL is injected.
# [database]
# migrations = "migrations/"

# Plain configuration (visible in the console). Secrets reference org secrets, whose values a
# platform admin sets (the console only lists them):
# [variables]
# LOG_LEVEL = "info"
# [secrets]
# OPENAI_API_KEY = "org/openai"
`;
}

const AGENTS_START = '<!-- BOXLITE:START -->';
const AGENTS_END = '<!-- BOXLITE:END -->';

/** The block `init` keeps in AGENTS.md so any coding agent opening the project knows the ropes. */
export function agentsBlock(app: string): string {
  return [
    AGENTS_START,
    '## BoxLite App',
    '',
    `This project is the BoxLite App **${app}**. Talk to the platform only through \`boxlite-app\` (key in \`BOXLITE_API_KEY\`, never printed or committed).`,
    '',
    '- Start of a session: `boxlite-app whoami`, then `boxlite-app app context` (services, schema, variables, recent errors, next actions).',
    '- Something wrong: `boxlite-app doctor` lists the problems with a fix each.',
    '- Loop: edit → `boxlite-app check` → `boxlite-app plan` → `boxlite-app deploy -m "…"` → verify with `boxlite-app app curl <path>`.',
    '- Runtime rules: listen on `$PORT` and `0.0.0.0`; never hardcode the app URL (use `BOXLITE_APP_URL`); data only in the database or a volume.',
    '- Verify like a browser: `boxlite-app app curl <path>` (works for private apps; `--as qa@example.com` for signed-in pages).',
    '- Schema changes: a new file from `boxlite-app app db migration new <name>`; never edit an applied migration.',
    '- Full guide offline: `boxlite-app docs`; every command and JSON shape: `boxlite-app docs reference`.',
    AGENTS_END,
  ].join('\n');
}

export function mergeAgentsMd(existing: string | null, app: string): string {
  const block = agentsBlock(app);
  if (existing === null || existing.trim() === '') return `# AGENTS.md\n\n${block}\n`;
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end > start) return `${existing.slice(0, start)}${block}${existing.slice(end + AGENTS_END.length)}`;
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function init(ctx: Ctx, opts: { app?: string; agentsMd?: boolean }): Promise<void> {
  const api = ctx.api();
  const requested = opts.app ?? ctx.app;
  let info;
  try {
    info = await api.getApp(requested ?? 'me');
  } catch (e) {
    // Not every control plane resolves the App from the key via the `me` alias.
    if (!requested && e instanceof MicrocloudError && e.code === 'not_found_app') throw new MicrocloudError('not_found_app', e.message, '`boxlite-app init --app <name>` with the App name from the App prompt');
    throw e;
  }
  const app = typeof info.name === 'string' && info.name ? info.name : requested;
  if (!app) throw new MicrocloudError('not_found_app', 'the control plane did not return an App name', '`boxlite-app init --app <name>` with the App name from the App prompt');
  const envInfo = info.envs?.find((e) => e.name === ctx.envName);
  const baseVersion = envInfo?.spec_version ?? envInfo?.latest_deployment?.spec_version ?? 0;

  const created: string[] = [];
  const unchanged: string[] = [];

  const tomlPath = join(ctx.cwd, MANIFEST_FILE);
  if (await exists(tomlPath)) unchanged.push(MANIFEST_FILE);
  else {
    await writeFile(tomlPath, manifestSkeleton(app));
    created.push(MANIFEST_FILE);
  }

  if (ctx.link) unchanged.push(LINK_FILE);
  else {
    await writeLink(ctx.cwd, { app, env: ctx.envName, base_version: baseVersion, api_url: api.baseUrl });
    created.push(LINK_FILE);
  }

  const gitignorePath = join(ctx.cwd, '.gitignore');
  if (await exists(gitignorePath)) {
    const current = (await readFile(gitignorePath, 'utf8')).split(/\r?\n/).map((l) => l.trim());
    const missing = GITIGNORE_LINES.filter((l) => !current.includes(l));
    if (missing.length > 0) {
      const text = await readFile(gitignorePath, 'utf8');
      await appendFile(gitignorePath, `${text.endsWith('\n') || text === '' ? '' : '\n'}${missing.join('\n')}\n`);
      created.push(`.gitignore (+${missing.join(', ')})`);
    } else unchanged.push('.gitignore');
  }

  if (opts.agentsMd !== false) {
    const path = join(ctx.cwd, 'AGENTS.md');
    const before = (await exists(path)) ? await readFile(path, 'utf8') : null;
    const after = mergeAgentsMd(before, app);
    if (after === before) unchanged.push('AGENTS.md');
    else {
      await writeFile(path, after);
      created.push(before === null ? 'AGENTS.md' : 'AGENTS.md (BoxLite block)');
    }
  }

  ctx.out.data({ app, env: ctx.envName, base_version: baseVersion, api_url: api.baseUrl, created, unchanged });
  ctx.out.line(`App ${app} · environment ${ctx.envName} · ${api.baseUrl}`);
  for (const f of created) ctx.out.line(`  created    ${f}`);
  for (const f of unchanged) ctx.out.line(`  unchanged  ${f}`);
  if (created.includes(MANIFEST_FILE)) ctx.out.next('edit boxlite.toml (`boxlite-app docs manifest`), then `boxlite-app check` and `boxlite-app deploy`');
  else ctx.out.next('`boxlite-app check`, then `boxlite-app plan`');
}

export function registerInit(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('init')
      .description('write boxlite.toml, .boxlite/link.json, .gitignore entries and an AGENTS.md block in the current directory (never overwrites)')
      .option('--app <name>', 'App name (default: the App the key belongs to)')
      .option('--no-agents-md', 'do not write the BoxLite block into AGENTS.md')
      .action(async (opts: { app?: string; agentsMd?: boolean }, cmd: Command) => init(await make(cmd), opts)),
    { json: '{ app, env, base_version, api_url, created: string[], unchanged: string[] }', exits: [2, 3, 6], online: true },
  );
}
