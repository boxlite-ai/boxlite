import { formatBytes, MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { table } from '../output.js';

/** Upload limit per file; the control plane enforces the same. */
export const VOLUME_FILE_MAX = 50 * 1024 * 1024;

export interface RemotePath {
  volume: string;
  path: string;
}

/** `uploads:/a/b.png` → {uploads, /a/b.png}; `uploads` → {uploads, /}. Anything else is local. */
export function parseRemote(spec: string): RemotePath | null {
  const m = /^([a-z][a-z0-9-]{0,30}):(.*)$/.exec(spec);
  if (!m) return null;
  const path = m[2] === '' ? '/' : m[2]!.startsWith('/') ? m[2]! : `/${m[2]}`;
  return { volume: m[1]!, path };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function ls(ctx: Ctx, target?: string): Promise<void> {
  const api = await ctx.appApi();
  if (!target) {
    const vols = await api.listVolumes();
    ctx.out.data(vols);
    if (!vols.length) {
      ctx.out.line('no volumes declared');
      ctx.out.next('add a [[volume]] (name, mount) to boxlite.toml, then `boxlite-app apply --yes`');
      return;
    }
    for (const line of table(vols.map((v) => [v.name, v.mount, v.mode]))) ctx.out.line(line);
    ctx.out.next(`\`boxlite-app app volume ls ${vols[0]!.name}\` lists its files`);
    return;
  }
  const remote = parseRemote(target.includes(':') ? target : `${target}:/`);
  if (!remote) throw new MicrocloudError('usage', `"${target}" is not <volume>[:<path>]`, '`boxlite-app app volume ls uploads:/avatars`');
  const got = await api.volumeGet(remote.volume, remote.path);
  if ('file' in got) {
    const size = Number(got.file.headers.get('content-length') ?? got.file.headers.get('x-boxlite-file-size') ?? 0);
    await got.file.body?.cancel().catch(() => undefined);
    const entry = { volume: remote.volume, path: remote.path, type: 'file' as const, size };
    ctx.out.data(entry);
    ctx.out.line(`${remote.volume}:${remote.path}  file  ${formatBytes(size)}`);
    ctx.out.next(`\`boxlite-app app volume cp ${remote.volume}:${remote.path} ./${basename(remote.path)}\``);
    return;
  }
  const listing = got.listing;
  ctx.out.data(listing);
  if (!listing.entries.length) ctx.out.line(`${remote.volume}:${listing.path} is empty`);
  const rows = listing.entries.map((e) => [e.type === 'dir' ? `${e.name}/` : e.name, e.type === 'dir' ? '' : formatBytes(e.size), e.mode, e.modified_at]);
  for (const line of table(rows)) ctx.out.line(line);
}

async function cp(ctx: Ctx, src: string, dst: string, opts: { force?: boolean }): Promise<void> {
  const from = parseRemote(src);
  const to = parseRemote(dst);
  if ((from && to) || (!from && !to)) {
    throw new MicrocloudError('usage', 'exactly one side must be a volume path (<volume>:<path>)', '`boxlite-app app volume cp ./logo.png uploads:/logo.png` or `boxlite-app app volume cp uploads:/logo.png ./logo.png`');
  }
  const api = await ctx.appApi();
  if (to) {
    const local = resolve(ctx.cwd, src);
    let st;
    try {
      st = await stat(local);
    } catch {
      throw new MicrocloudError('not_found', `local file ${src} does not exist`, 'check the path; only single files can be copied');
    }
    if (!st.isFile()) throw new MicrocloudError('usage', `${src} is not a file; copy files one at a time`, `\`boxlite-app app volume cp <file> ${dst}\``);
    if (st.size > VOLUME_FILE_MAX) throw new MicrocloudError('usage', `${src} is ${formatBytes(st.size)}; the limit is ${formatBytes(VOLUME_FILE_MAX)}`, 'split the file or let the app write it');
    const path = to.path.endsWith('/') ? `${to.path}${basename(local)}` : to.path;
    const res = await api.volumePut(to.volume, path, await readFile(local), opts.force === true);
    ctx.out.data({ direction: 'upload', local, ...res });
    ctx.out.line(`${src} → ${res.volume}:${res.path} (${formatBytes(res.bytes)}${res.replaced ? ', replaced' : ''})`);
    return;
  }
  const remote = from!;
  const got = await api.volumeGet(remote.volume, remote.path);
  if ('listing' in got) throw new MicrocloudError('usage', `${src} is a directory; copy files one at a time`, `\`boxlite-app app volume ls ${src}\` lists them`);
  const target = (await isDir(resolve(ctx.cwd, dst))) || dst.endsWith('/') ? join(resolve(ctx.cwd, dst), basename(remote.path)) : resolve(ctx.cwd, dst);
  if (!opts.force && (await stat(target).then(() => true, () => false))) {
    await got.file.body?.cancel().catch(() => undefined);
    throw new MicrocloudError('exists', `${target} already exists`, `rerun with --force to overwrite: \`${ctx.commandLine(['--force'])}\``);
  }
  if (!got.file.body) throw new MicrocloudError('unavailable', 'empty response from the control plane', `rerun \`${ctx.commandLine()}\``);
  await pipeline(Readable.fromWeb(got.file.body as import('node:stream/web').ReadableStream), createWriteStream(target));
  const bytes = (await stat(target)).size;
  ctx.out.data({ direction: 'download', volume: remote.volume, path: remote.path, local: target, bytes });
  ctx.out.line(`${remote.volume}:${remote.path} → ${target} (${formatBytes(bytes)})`);
}

export function registerVolume(app: Command, make: MakeCtx): void {
  const volume = app.command('volume').description('files on the environment’s volumes ([[volume]] in boxlite.toml)');
  describe(
    volume
      .command('ls [target]')
      .description('list volumes, or the files under <volume>[:<path>]')
      .action(async (target: string | undefined, _o: unknown, cmd: Command) => ls(await make(cmd), target)),
    {
      json: 'no target: { name, mount, mode }[]; directory: { volume, path, type: "dir", entries: { name, type, size, mode, modified_at }[] }; file: { volume, path, type: "file", size }',
      exits: [2, 3, 4],
      online: true,
      examples: ['boxlite-app app volume ls', 'boxlite-app app volume ls uploads:/avatars'],
    },
  );
  describe(
    volume
      .command('cp <src> <dst>')
      .description('copy one file between this machine and a volume: cp <local> <volume>:<path> | cp <volume>:<path> <local>')
      .option('--force', 'overwrite an existing file at the destination')
      .action(async (src: string, dst: string, opts: { force?: boolean }, cmd: Command) => cp(await make(cmd), src, dst, opts)),
    {
      json: '{ direction: "upload" | "download", volume, path, local, bytes, replaced? }',
      exits: [2, 3, 4],
      online: true,
      examples: ['boxlite-app app volume cp ./seed/logo.png uploads:/logo.png', 'boxlite-app app volume cp uploads:/exports/report.csv ./'],
    },
  );
}
