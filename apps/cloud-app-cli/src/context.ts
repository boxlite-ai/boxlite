import { MicrocloudError } from '@boxlite-ai/cloud-app-shared'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { Dispatcher } from 'undici'
import { Api } from './api.js'
import { Output } from './output.js'
import { savedKey } from './credentials.js'

export interface Io {
  stdout: Writable
  stderr: Writable
  stdin: Readable
  isTTY: boolean
}

export interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  io: Io
  /** undici dispatcher; tests inject a MockAgent. */
  dispatcher?: Dispatcher
}

export interface Link {
  app: string
  env: string
  /** Spec version the local boxlite.toml was last synced with; 0 when the env has no spec yet. */
  base_version: number
  api_url: string
}

export const LINK_FILE = join('.boxlite', 'link.json')

export async function readLink(cwd: string): Promise<Link | null> {
  let text: string
  try {
    text = await readFile(join(cwd, LINK_FILE), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new MicrocloudError(
      'invalid_link',
      `${LINK_FILE} is not valid JSON`,
      `delete ${LINK_FILE} and run \`boxlite-app init\``,
    )
  }
  const link = data as Partial<Link>
  if (typeof link.app !== 'string' || typeof link.env !== 'string') {
    throw new MicrocloudError(
      'invalid_link',
      `${LINK_FILE} must contain app and env`,
      `delete ${LINK_FILE} and run \`boxlite-app init\``,
    )
  }
  return {
    app: link.app,
    env: link.env,
    base_version: typeof link.base_version === 'number' ? link.base_version : 0,
    api_url: typeof link.api_url === 'string' ? link.api_url : '',
  }
}

export async function writeLink(cwd: string, link: Link): Promise<void> {
  const path = join(cwd, LINK_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(link, null, 2)}\n`)
}

/** Merges `patch` into the existing link.json; a no-op when the project is not linked. */
export async function updateLink(cwd: string, patch: Partial<Link>): Promise<Link | null> {
  const current = await readLink(cwd)
  if (!current) return null
  const next = { ...current, ...patch }
  await writeLink(cwd, next)
  return next
}

export interface GlobalOpts {
  json?: boolean
  app?: string
  env?: string
  yes?: boolean
}

/** What a destructive command is about to do, shown before it asks (or refuses). */
export interface DestructiveBrief {
  /** e.g. `delete environment dev` */
  action: string
  /** Each item that will be destroyed or replaced. */
  destroys: string[]
  /** How (or whether) it can be undone. */
  undo: string
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

export class Ctx {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly io: Io
  readonly json: boolean
  readonly yes: boolean
  readonly envName: string
  readonly link: Link | null
  readonly out: Output
  readonly dispatcher: Dispatcher | undefined
  /** The argv this command was invoked with (without node/script), for "rerun with" hints. */
  readonly argv: readonly string[]
  private apiInstance: Api | undefined
  private readonly requestedApp: string | undefined

  constructor(run: RunOptions, opts: GlobalOpts, link: Link | null, argv: readonly string[] = [], out?: Output) {
    this.cwd = run.cwd
    this.env = run.env
    this.io = run.io
    this.json = opts.json === true
    this.yes = opts.yes === true
    this.link = link
    this.requestedApp = opts.app
    this.envName = opts.env ?? link?.env ?? 'main'
    this.out = out ?? new Output(run.io, this.json)
    this.dispatcher = run.dispatcher
    this.argv = argv
  }

  /** BOXLITE_API_KEY, else the key saved for the organization. */
  get apiKey(): string | undefined {
    return this.env.BOXLITE_API_KEY || savedKey(this.env, this.apiUrl)?.key
  }

  get apiUrl(): string | undefined {
    return this.env.BOXLITE_API_URL || this.link?.api_url || savedKey(this.env)?.api_url
  }

  /** The explicit App or the App selected by the project link. */
  get app(): string | undefined {
    if (this.requestedApp && this.link && this.requestedApp !== this.link.app) {
      throw new MicrocloudError(
        'invalid_link',
        `this directory is linked to ${this.link.app}, but --app selects ${this.requestedApp}`,
        'run the command in the selected App’s project directory',
      )
    }
    return this.requestedApp ?? this.link?.app ?? (this.env.BOXLITE_APP || undefined)
  }

  /** Spec version the local manifest is based on (0 = none yet). */
  get baseVersion(): number {
    return this.link?.base_version ?? 0
  }

  /** The exact command line, for "rerun with" hints. */
  commandLine(extra: string[] = []): string {
    return ['boxlite-app', ...[...this.argv, ...extra].map(shellQuote)].join(' ')
  }

  /** Organization API client with the locally selected App, when present. */
  api(): Api {
    if (this.apiInstance) return this.apiInstance
    const url = this.apiUrl
    if (!url)
      throw new MicrocloudError(
        'missing_api_url',
        'no organization API URL is selected',
        'set BOXLITE_API_URL to the organization URL from the App prompt, then `boxlite-app whoami`',
      )
    const key = this.apiKey
    if (!key)
      throw new MicrocloudError(
        'unauthenticated',
        'no API key for this organization: BOXLITE_API_KEY is not set and none is saved',
        'save your organization API key with `BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login`',
      )
    this.apiInstance = new Api({ baseUrl: url, key, app: this.app, env: this.envName, dispatcher: this.dispatcher })
    return this.apiInstance
  }

  appName(): string {
    const app = this.app
    if (!app)
      throw new MicrocloudError(
        'not_linked',
        'no App is selected',
        'pass --app <name> or link the project with `boxlite-app init --app <name>`',
      )
    return app
  }

  /** Client scoped to the App and environment of this command. */
  async appApi(): Promise<Api> {
    this.appName()
    return this.api()
  }

  /** Non-destructive prompt (apply): `--yes` and `--json` proceed; without a TTY the command refuses instead of hanging. */
  async confirm(question: string, action: string): Promise<boolean> {
    if (this.yes || this.json) return true
    if (!this.io.isTTY)
      throw new MicrocloudError(
        'confirmation_required',
        `refusing to ${action} without --yes`,
        `rerun as \`${this.commandLine(['--yes'])}\``,
      )
    return this.ask(question)
  }

  /**
   * Destructive actions always say what they destroy. Without `--yes` they only proceed after a
   * "y" on a terminal; in `--json` mode or without a TTY they fail with `confirmation_required`
   * and the exact command to rerun.
   */
  async confirmDestructive(brief: DestructiveBrief): Promise<boolean> {
    const lines = [`This will ${brief.action}:`, ...brief.destroys.map((d) => `  - ${d}`), `Undo: ${brief.undo}`]
    if (this.yes) {
      for (const l of lines) this.out.note(l)
      return true
    }
    if (this.json || !this.io.isTTY) {
      for (const l of lines) this.out.note(l)
      throw new MicrocloudError(
        'confirmation_required',
        `refusing to ${brief.action} without --yes`,
        `rerun as \`${this.commandLine(['--yes'])}\` once the user agreed`,
        {
          action: brief.action,
          destroys: brief.destroys,
          undo: brief.undo,
          command: this.commandLine(['--yes']),
        },
      )
    }
    for (const l of lines) this.out.note(l)
    return this.ask('Proceed?')
  }

  private async ask(question: string): Promise<boolean> {
    const rl = createInterface({ input: this.io.stdin, output: this.io.stdout })
    try {
      const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve))
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  }
}

export async function createCtx(
  run: RunOptions,
  opts: GlobalOpts,
  argv: readonly string[] = [],
  out?: Output,
): Promise<Ctx> {
  return new Ctx(run, opts, await readLink(run.cwd), argv, out)
}
