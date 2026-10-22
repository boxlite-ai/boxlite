#!/usr/bin/env node
// Live end-to-end suite for environments: a person in the console and an agent with the CLI,
// against the real control plane, real Boxes and real Neon branches.
//
//   CP_URL=… node e2e/env-live.mjs [--keep]
//
// Creates App "env-<timestamp>" in the platform org, deploys main, then checks that every
// environment is its own copy: schema-only and with-data forks, its own URL, its own variables
// (and "Copy from"), its own logs and signed-in users, and that deleting one leaves main serving.
// Purges the App at the end unless --keep.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = (process.env.CP_URL ?? 'https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai').replace(/\/+$/, '')
const CONSOLE = CP.replace(/^(https?:\/\/)8080-/, '$18081-')
const ADMIN = readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const CLI = join(ROOT, 'cli/dist/boxlite-app.cjs')
const KEEP = process.argv.includes('--keep')
const APP = `env-${Date.now().toString(36)}`
const results = []
let KEY = ''
let DIR = ''
let consoleCookie = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cli(args, { json = true } = {}) {
  const r = spawnSync('node', [CLI, ...args, ...(json ? ['--json'] : [])], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    env: { ...process.env, BOXLITE_API_URL: CP, BOXLITE_API_KEY: KEY },
  })
  let parsed = null
  try { parsed = JSON.parse(r.stdout) } catch { try { parsed = JSON.parse(r.stderr) } catch { /* human output */ } }
  return { code: r.status, out: r.stdout, err: r.stderr, json: parsed }
}

/** The console API as a signed-in person: cookie and the CSRF header. */
async function consoleApi(path, { method = 'GET', json, env } = {}) {
  const url = `${CONSOLE}/console/api${path}${env ? `${path.includes('?') ? '&' : '?'}env=${encodeURIComponent(env)}` : ''}`
  const r = await fetch(url, {
    method,
    headers: { cookie: consoleCookie, 'x-boxlite-console': '1', ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
  const text = await r.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, body }
}

/** One environment's app, fetched the way an agent verifies it (App key as Bearer). */
async function appGet(url, path) {
  const r = await fetch(`${url.replace(/\/+$/, '')}${path}`, { headers: { authorization: `Bearer ${KEY}` }, redirect: 'manual' })
  const text = await r.text()
  try { return { status: r.status, body: JSON.parse(text) } } catch { return { status: r.status, body: text } }
}

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = (await fn()) ?? ''
    results.push({ name, ok: true })
    console.log(`  ✔ ${name}  ${detail}`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  ✖ ${name}  ${e.message}`)
  }
  void t0
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
async function until(fn, { timeoutMs = 180_000, everyMs = 3_000, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e.message }
    await sleep(everyMs)
  }
  throw new Error(`timed out waiting for ${what} (last: ${typeof last === 'string' ? last : JSON.stringify(last)})`)
}
const envUrl = (name) => cli(['app', 'status']).json?.envs?.find((e) => e.name === name)?.url
/** The newest deployment of an env, once it finished. */
async function settled(env) {
  return until(async () => {
    const d = cli(['app', 'deployments', '--env', env]).json?.[0]
    return d && ['live', 'failed', 'cancelled'].includes(d.status) ? d : null
  }, { what: `${env}'s deployment to finish` })
}

async function main() {
  console.log(`Environments e2e · CP ${CP} · console ${CONSOLE} · app ${APP}`)
  DIR = mkdtempSync(join(tmpdir(), 'env-e2e-'))
  cpSync(join(ROOT, 'e2e/fixtures/kitchen-sink'), DIR, { recursive: true })
  const toml = join(DIR, 'boxlite.toml')
  writeFileSync(toml, readFileSync(toml, 'utf8').replace('name = "e2e"', `name = "${APP}"`))

  const created = await fetch(`${CP}/v1/apps`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: APP }) })
  KEY = (await created.json()).key
  await fetch(`${CP}/admin/secrets/org/e2e-secret`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: 's3cr3t-value' }) })
  const login = await fetch(`${CONSOLE}/console/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(ADMIN)}` })
  consoleCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

  try {
    let mainUrl = ''
    await check('main is deployed and holds two rows', async () => {
      assert(cli(['init']).code === 0, 'init failed')
      const d = cli(['deploy', '-m', 'env-e2e main'])
      assert(d.code === 0, `deploy exit ${d.code}: ${d.err.slice(0, 300)}`)
      mainUrl = envUrl('main')
      for (const title of ['first', 'second']) {
        const r = await fetch(`${mainUrl}/api/items`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
        assert(r.ok, `insert ${title}: ${r.status}`)
      }
      const items = await appGet(mainUrl, '/api/items')
      assert(items.body.length === 2, `main has ${JSON.stringify(items.body)}`)
      return mainUrl
    })

    let stagingUrl = ''
    await check('the agent forks staging from main (schema, no rows) and deploys to it', async () => {
      const e = cli(['app', 'env', 'create', 'staging'])
      assert(e.code === 0, `env create exit ${e.code}: ${e.err.slice(0, 300)}`)
      const d = cli(['deploy', '--env', 'staging', '-m', 'env-e2e staging'])
      assert(d.code === 0, `deploy --env staging exit ${d.code}: ${d.err.slice(0, 300)}`)
      stagingUrl = envUrl('staging')
      assert(stagingUrl && stagingUrl !== mainUrl, `staging url ${stagingUrl} vs main ${mainUrl}`)
      const env = await appGet(stagingUrl, '/api/env')
      assert(env.body.env === 'staging' && env.body.app_url.replace(/\/$/, '') === stagingUrl.replace(/\/$/, ''), `staging /api/env ${JSON.stringify(env.body)}`)
      const items = await appGet(stagingUrl, '/api/items')
      assert(Array.isArray(items.body) && items.body.length === 0, `staging rows ${JSON.stringify(items.body)}`)
      return stagingUrl
    })

    await check('a variable changed in the console on staging stays on staging', async () => {
      const set = await consoleApi(`/apps/${APP}/actions`, { method: 'POST', env: 'staging', json: { type: 'setVariable', name: 'GREETING', value: 'from staging' } })
      assert(set.status === 200, `setVariable ${set.status} ${JSON.stringify(set.body).slice(0, 200)}`)
      const d = await settled('staging')
      assert(d.status === 'live', `staging apply ${d.status}`)
      await until(async () => (await appGet(stagingUrl, '/api/env')).body.greeting === 'from staging' || null, { what: 'staging greeting' })
      const main = await appGet(mainUrl, '/api/env')
      assert(main.body.greeting === 'hello', `main greeting became ${main.body.greeting}`)
      return 'staging "from staging", main "hello"'
    })

    let copyUrl = ''
    await check('the console forks "copy" from main with its data', async () => {
      const r = await consoleApi(`/apps/${APP}/environments`, { method: 'POST', json: { name: 'copy', from: 'main', withData: true } })
      assert(r.status === 201, `create ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
      const d = cli(['deploy', '--env', 'copy', '-m', 'env-e2e copy'])
      assert(d.code === 0, `deploy --env copy exit ${d.code}: ${d.err.slice(0, 300)}`)
      copyUrl = envUrl('copy')
      const items = await appGet(copyUrl, '/api/items')
      assert(Array.isArray(items.body) && items.body.length === 2, `copy rows ${JSON.stringify(items.body)}`)
      return '2 rows copied'
    })

    await check('"Copy from staging" brings staging variables into copy', async () => {
      const r = await consoleApi(`/apps/${APP}/variables/copy`, { method: 'POST', env: 'copy', json: { from: 'staging' } })
      assert(r.status === 200, `copy ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
      const d = await settled('copy')
      assert(d.status === 'live', `copy apply ${d.status}`)
      await until(async () => (await appGet(copyUrl, '/api/env')).body.greeting === 'from staging' || null, { what: 'copy greeting' })
      return 'copy "from staging"'
    })

    await check('each environment has its own logs', async () => {
      const staging = JSON.stringify(cli(['app', 'logs', '--env', 'staging', '--since', '1h']).json ?? [])
      const main = JSON.stringify(cli(['app', 'logs', '--env', 'main', '--since', '1h']).json ?? [])
      assert(/env-e2e staging|deployment #1 is live/.test(staging), 'staging has no deployment lines')
      assert(!staging.includes(mainUrl.replace(/^https?:\/\//, '')), 'staging logs mention main’s URL')
      assert(!main.includes(stagingUrl.replace(/^https?:\/\//, '')), 'main logs mention staging’s URL')
      return 'separate'
    })

    await check('a signed-in user of staging is not a user of main', async () => {
      const s = cli(['app', 'auth', 'test-session', '--env', 'staging', '--email', 'qa@env-e2e.test'])
      assert(s.code === 0, `test-session exit ${s.code}: ${s.err.slice(0, 200)}`)
      const stagingUsers = cli(['app', 'auth', 'users', '--env', 'staging']).json ?? []
      const mainUsers = cli(['app', 'auth', 'users', '--env', 'main']).json ?? []
      assert(stagingUsers.some((u) => u.email === 'qa@env-e2e.test'), 'not in staging')
      assert(!mainUsers.some((u) => u.email === 'qa@env-e2e.test'), 'leaked into main')
      return 'separate user pools'
    })

    await check('the console lists three environments, each with its own URL', async () => {
      const r = await consoleApi(`/apps/${APP}/environments`)
      const names = r.body.map((e) => e.name).sort()
      assert(JSON.stringify(names) === JSON.stringify(['copy', 'main', 'staging']), `envs ${names}`)
      const urls = new Set(r.body.map((e) => e.url))
      assert(urls.size === 3, `urls ${[...urls]}`)
      return names.join(', ')
    })

    await check('deleting copy (console) and staging (CLI) leaves main serving', async () => {
      const del = await consoleApi(`/apps/${APP}/environments/copy`, { method: 'DELETE' })
      assert(del.status === 204, `console delete ${del.status}`)
      const cliDel = cli(['app', 'env', 'delete', 'staging', '--yes'])
      assert(cliDel.code === 0, `env delete exit ${cliDel.code}: ${cliDel.err.slice(0, 200)}`)
      const envs = (cli(['app', 'status']).json?.envs ?? []).map((e) => e.name)
      assert(JSON.stringify(envs) === '["main"]', `left ${envs}`)
      const gone = await appGet(stagingUrl, '/api/env')
      assert(gone.status >= 400, `old staging URL still answers ${gone.status}`)
      const main = await appGet(mainUrl, '/api/items')
      assert(main.status === 200 && main.body.length === 2, `main ${main.status} ${JSON.stringify(main.body)}`)
      return `old staging URL → ${gone.status}`
    })
  } finally {
    if (!KEEP) {
      const r = await fetch(`${CP}/v1/apps/${APP}?purge=1`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
      console.log(`  purge ${APP}: ${r.status}`)
    }
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
