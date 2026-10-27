import { parseInvocation } from 'mstage/cli'
import { loadConfig } from 'mstage/config'
import { readEnvironment } from 'mstage/env'
import { resolveHome } from 'mstage/home'
import { run as mstage } from 'mstage/run'
import { resolveScope } from 'mstage/scope'
import { publicHostsFor } from '../stack/hosts.ts'
import { MAX_RUNNERS, RUNNER_NAME } from '../stack/runners.ts'

const USAGE = 'npm run runner:drain -- --stage <stage> --runners <name[,name...]> [--confirm]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
type Runner = { id: string; name: string; region: string; state: string }

/** Request drain and return after acceptance; migration belongs to the API workers. */
export const drainRunners = async ({
  argv,
  cwd = process.cwd(),
  environment = process.env,
  log = console.log,
  checkLogin = mstage,
  resolveHomeWith = resolveHome,
  readStore = readEnvironment,
  fetchWith = fetch,
}: {
  argv: string[]
  cwd?: string
  environment?: NodeJS.ProcessEnv
  log?: (message: string) => void
  checkLogin?: typeof mstage
  resolveHomeWith?: typeof resolveHome
  readStore?: typeof readEnvironment
  fetchWith?: typeof fetch
}): Promise<number> => {
  const { options, command, inner } = parseInvocation(['drain', ...argv], environment, { values: ['runners'] })
  if (command || inner || Object.keys(options).some((key) => !['stage', 'runners', 'confirm', 'help'].includes(key))) {
    throw new Error(USAGE)
  }
  if (options.help) {
    log(USAGE)
    return 0
  }
  const names = [
    ...new Set(
      String(options.runners ?? '')
        .split(',')
        .map((name) => name.trim()),
    ),
  ]
  if (names.length > MAX_RUNNERS || names.some((name) => !RUNNER_NAME.test(name))) {
    throw new Error(`Provide 1–${MAX_RUNNERS} explicit runner names, separated by commas. ${USAGE}`)
  }
  const config = loadConfig({ cwd, environment })
  const scope = resolveScope({ options, config, environment })
  if (scope.protect && options.confirm !== true) {
    throw new Error(`Stage "${scope.stage}" is protected. Add --confirm to request drain.`)
  }
  if ((await checkLogin({ argv: ['login', '--stage', scope.stage!], environment, cwd, log })) !== 0) {
    throw new Error('Required sign-ins are missing; run `npm run mstage login -- -f` first')
  }
  const home = await resolveHomeWith({ scope })
  const values = await readStore({ clients: home.backend, app: scope.app!, stage: scope.stage! })
  const domain = values.STACK_DOMAIN?.trim()
  const key = values.ADMIN_API_KEY
  if (!domain || !DOMAIN.test(domain)) throw new Error('STACK_DOMAIN must be a DNS domain without a scheme or path')
  if (!key) throw new Error('ADMIN_API_KEY is missing from the stage store')
  if (environment.GITHUB_ACTIONS === 'true') {
    log(`::add-mask::${key.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`)
  }
  const origin = `https://${publicHostsFor({ domain }).api}`
  const region = values.DEFAULT_REGION_ID || 'us'
  const collection = `/api/admin/runners?${new URLSearchParams({ regionId: region })}`
  const request = async (path: string, method: 'GET' | 'PATCH'): Promise<Response> => {
    let response: Response
    try {
      response = await fetchWith(`${origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ draining: true }) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // Transport errors can include credentials or server text. A failed PATCH may have applied.
      throw new Error(`${method} ${path} failed (network, timeout or redirect); inspect API state before retrying`)
    }
    if (response.status !== (method === 'GET' ? 200 : 204)) {
      throw new Error(`${method} ${path} returned HTTP ${response.status}`)
    }
    return response
  }
  const response = await request(collection, 'GET')
  const runners: unknown = await response.json().catch(() => {
    throw new Error('Runner list is not valid JSON')
  })
  if (!Array.isArray(runners)) throw new Error('Runner list must be an array')
  // Resolve every target before writing: a typo in the second name must not drain the first.
  const targets: Runner[] = names.map((name) => {
    const matches = runners.filter((runner) => runner?.name === name && runner?.region === region)
    if (matches.length !== 1) throw new Error(`Runner "${name}" must match exactly once in region "${region}"`)
    const runner = matches[0]
    if (typeof runner.id !== 'string' || !UUID.test(runner.id) || typeof runner.state !== 'string') {
      throw new Error(`Runner "${name}" has an invalid API response`)
    }
    if (runner.state === 'decommissioned') throw new Error(`Runner "${name}" is already decommissioned`)
    return runner
  })
  for (const runner of targets) {
    await request(`/api/admin/runners/${runner.id}/draining`, 'PATCH')
    log(`${runner.name} (${runner.id}): draining=true accepted`)
  }
  log('Drain requests accepted. Migration completion and runner retirement are separate operations.')
  return 0
}
