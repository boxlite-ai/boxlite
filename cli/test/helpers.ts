import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { MockAgent, type Dispatcher } from 'undici';
import { run } from '../src/cli.js';

export const API = 'http://cp.test';
export const KEY = 'bxl_app_' + 'a'.repeat(32);

export const BASE_TOML = 'name = "crm"\n[runtime]\nimage = "node"\nbuild = ["npm ci", "npm run build"]\n[[service]]\nname = "web"\ncommand = "npm start"\nport = 3000\n';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  lines: string[];
}

export interface RunOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  dispatcher?: Dispatcher;
  isTTY?: boolean;
  stdin?: string;
}

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

/** Runs the CLI in-process with captured output. `env` defaults to key + API URL. */
export async function cli(argv: string[], opts: RunOpts): Promise<CliResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = new PassThrough();
  if (opts.stdin !== undefined) stdin.end(opts.stdin);
  const env = opts.env ?? { BOXLITE_API_KEY: KEY, BOXLITE_API_URL: API };
  const code = await run(argv, { cwd: opts.cwd, env, io: { stdout, stderr, stdin, isTTY: opts.isTTY ?? false }, dispatcher: opts.dispatcher });
  return { code, stdout: stdout.text, stderr: stderr.text, lines: stdout.text.split('\n').filter((l) => l !== '') };
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'microcloud-cli-'));
}

export async function project(root: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(root, 'p-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function mockApi(): { agent: MockAgent; pool: ReturnType<MockAgent['get']> } {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return { agent, pool: agent.get(API) };
}

export const JSON_HEADERS = { 'content-type': 'application/json' };
export const SSE_HEADERS = { 'content-type': 'text/event-stream' };

export function sse(events: { event: string; data: unknown; id?: string }[]): string {
  return events.map((e) => `${e.id !== undefined ? `id: ${e.id}\n` : ''}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

export function linkJson(base_version = 1, env = 'main'): string {
  return JSON.stringify({ app: 'crm', env, base_version, api_url: API });
}

export function parseJsonLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}
