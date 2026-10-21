import { exposedService, MicrocloudError, type Manifest, type ServiceSpec } from '@microcloud/shared';
import type { Command } from 'commander';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { pad } from '../output.js';
import { requireCheck } from './common.js';

export const DEV_PORT = 3000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function quoteEnvValue(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./?&-]*$/.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function renderDotenv(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([k, v]) => `${k}=${quoteEnvValue(v)}`)
    .join('\n')}\n`;
}

/** Tiny static file server for `static = "dir/"` services (index.html for directories, no listing). */
export function serveStatic(root: string, port: number): Promise<Server> {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    let file = normalize(join(base, urlPath));
    if (!file.startsWith(base + sep) && file !== base) {
      res.writeHead(403).end();
      return;
    }
    try {
      let st = await stat(file);
      if (st.isDirectory()) {
        file = join(file, 'index.html');
        st = await stat(file);
      }
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': st.size });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

function runCommand(ctx: Ctx, name: string, command: string, env: NodeJS.ProcessEnv, width: number): ChildProcess {
  const child = spawn('sh', ['-c', command], { cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${pad(name, width)} | `;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => (ctx.json ? ctx.out.stream({ source: name, line }) : ctx.out.line(prefix + line)));
  }
  return child;
}

function runBuild(ctx: Ctx, manifest: Manifest, env: NodeJS.ProcessEnv): Promise<void> {
  return manifest.runtime.build.reduce(
    (prev, command) =>
      prev.then(
        () =>
          new Promise<void>((resolvePromise, reject) => {
            ctx.out.line(`build | ${command}`);
            runCommand(ctx, 'build', command, env, 5).on('exit', (code) => (code === 0 ? resolvePromise() : reject(new MicrocloudError('build_failed', `build command failed (exit ${code}): ${command}`))));
          }),
      ),
    Promise.resolve(),
  );
}

async function dev(ctx: Ctx, opts: { as?: string; build?: boolean }): Promise<void> {
  const checked = await requireCheck(ctx);
  const manifest = checked.manifest;
  const { env: remote } = await (await ctx.appApi()).devEnv();
  const devEnv: Record<string, string> = { ...remote, BOXLITE_ENV: remote.BOXLITE_ENV ?? ctx.envName };
  if (opts.as) devEnv.BOXLITE_DEV_USER = opts.as;
  await writeFile(join(ctx.cwd, '.env.local'), renderDotenv(devEnv), { mode: 0o600 });
  ctx.out.line(`wrote .env.local (${Object.keys(devEnv).length} variables, mode 0600; keep it out of git)`);
  ctx.out.stream({ source: 'dev', line: `wrote .env.local (${Object.keys(devEnv).length} variables)` });

  const baseEnv: NodeJS.ProcessEnv = { ...ctx.env, ...devEnv };
  if (opts.build) await runBuild(ctx, manifest, baseEnv);

  const exposed = exposedService(manifest);
  const commandServices = manifest.services.filter((s): s is ServiceSpec & { command: string } => typeof s.command === 'string');
  const width = Math.max(...manifest.services.map((s) => s.name.length), 3);
  const children: ChildProcess[] = [];
  let server: Server | undefined;

  if (exposed?.static !== undefined) {
    server = await serveStatic(join(ctx.cwd, exposed.static), DEV_PORT);
    ctx.out.line(`${pad(exposed.name, width)} | serving ${exposed.static} at http://localhost:${DEV_PORT}/`);
  }
  for (const svc of commandServices) {
    const env = { ...baseEnv };
    if (svc === exposed) env.PORT = String(DEV_PORT);
    const child = runCommand(ctx, svc.name, svc.command, env, width);
    children.push(child);
    child.on('exit', (code, sig) => ctx.out.line(`${pad(svc.name, width)} | exited (${sig ?? code})`));
  }
  if (exposed?.command !== undefined) ctx.out.line(`${pad(exposed.name, width)} | expected at http://localhost:${DEV_PORT}/`);
  if (children.length === 0 && !server) {
    ctx.out.line('nothing to run');
    return;
  }

  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      ctx.out.line('stopping…');
      for (const c of children) c.kill('SIGTERM');
      server?.close();
      setTimeout(() => {
        for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
        resolvePromise();
      }, 3000).unref();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let running = children.length;
    for (const c of children) {
      c.on('exit', () => {
        running--;
        if (running === 0 && !server) resolvePromise();
      });
    }
  });
}

export function registerDev(app: Command, make: MakeCtx): void {
  describe(
    app
      .command('dev')
      .description("fetch the environment's variables into .env.local and run every service locally against the cloud database")
      .option('--as <email>', 'act as this end user (sets BOXLITE_DEV_USER)')
      .option('--build', 'run runtime.build first')
      .action(async (opts: { as?: string; build?: boolean }, cmd: Command) => dev(await make(cmd), opts)),
    { json: 'NDJSON stream: { source: string, line: string } per output line', exits: [2, 3, 7], online: true },
  );
}
