#!/usr/bin/env node
// Live end-to-end suite: drives the real control plane, real Boxes and a real Neon database
// through the agent's CLI, then checks every platform promise from the outside.
//
//   node e2e/run-live.mjs [--keep] [--only <check,...>]
//
// Needs CP_URL (defaults to the dev control plane) and the admin token in .cp-admin-token.
// Creates App "e2e-<timestamp>", deletes it at the end unless --keep. Writes e2e/report.md.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = process.env.CP_URL ?? 'https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai'
const ADMIN = readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const CLI = join(ROOT, 'cli/dist/boxlite-app.cjs')
const KEEP = process.argv.includes('--keep')
const APP = `e2e-${Date.now().toString(36)}`
const results = []
let KEY = ''
let DIR = ''
let cookie = ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Runs the CLI the way an agent would; returns {code, out, err, json}. */
function cli(args, { json = true, env = {} } = {}) {
  const full = json ? [...args, '--json'] : args
  const r = spawnSync('node', [CLI, ...full], {
    cwd: DIR, encoding: 'utf8', timeout: 20 * 60_000,
    env: { ...process.env, BOXLITE_API_URL: CP, BOXLITE_API_KEY: KEY, ...env },
  })
  let parsed = null
  try { parsed = JSON.parse(r.stdout) } catch { try { parsed = JSON.parse(r.stderr) } catch { /* human output */ } }
  return { code: r.status, out: r.stdout, err: r.stderr, json: parsed }
}

let APP_URL = ''
/**
 * Fetches the app the way an agent verifies it: the App key as a Bearer header opens a private
 * app (the platform strips it before the app sees the request). `anonymous` drops it.
 */
async function app(path, init = {}) {
  const { anonymous, ...rest } = init
  const headers = { ...(rest.headers ?? {}) }
  if (!anonymous) headers.authorization = `Bearer ${KEY}`
  if (cookie) headers.cookie = headers.cookie ? `${cookie}; ${headers.cookie}` : cookie
  return fetch(`${APP_URL}${path}`, { redirect: 'manual', ...rest, headers })
}

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = (await fn()) ?? ''
    results.push({ name, ok: true, ms: Date.now() - t0, detail })
    console.log(`  ✔ ${name}  ${detail}`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message })
    console.log(`  ✖ ${name}  ${e.message}`)
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

async function until(fn, { timeoutMs = 120_000, everyMs = 3_000, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e.message }
    await sleep(everyMs)
  }
  throw new Error(`timed out waiting for ${what} (last: ${typeof last === 'string' ? last : JSON.stringify(last)})`)
}

function setToml(edit) {
  const p = join(DIR, 'boxlite.toml')
  writeFileSync(p, edit(readFileSync(p, 'utf8')))
}

async function main() {
  console.log(`Live e2e against ${CP} · app ${APP}`)
  DIR = mkdtempSync(join(tmpdir(), 'mc-e2e-'))
  cpSync(join(ROOT, 'e2e/fixtures/kitchen-sink'), DIR, { recursive: true })
  setToml((s) => s.replace('name = "e2e"', `name = "${APP}"`))

  // ---- create ----------------------------------------------------------------------
  await check('admin creates the App and returns a key once', async () => {
    const r = await fetch(`${CP}/v1/apps`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: APP }) })
    const b = await r.json()
    assert(r.status === 201 && b.key?.startsWith('bxl_app_'), `status ${r.status} ${JSON.stringify(b).slice(0, 200)}`)
    KEY = b.key
    await fetch(`${CP}/admin/secrets/org/e2e-secret`, { method: 'PUT', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: 's3cr3t-value' }) })
    return b.app.url
  })
  await check('App key is scoped: another app is 403/404', async () => {
    const r = await fetch(`${CP}/v1/apps/hello`, { headers: { authorization: `Bearer ${KEY}` } })
    assert(r.status === 403 || r.status === 404, `got ${r.status}`)
    return `${r.status}`
  })
  await check('wrong key is exit 2 with a next step', async () => {
    const r = cli(['app', 'status'], { env: { BOXLITE_API_KEY: 'bxl_app_wrongwrongwrongwrongwrongwrong' } })
    assert(r.code === 2, `exit ${r.code}`)
    assert(/next/i.test(r.err + r.out), 'no next hint')
    return 'exit 2'
  })

  // ---- declare ---------------------------------------------------------------------
  await check('init links the directory without touching boxlite.toml', async () => {
    const before = readFileSync(join(DIR, 'boxlite.toml'), 'utf8')
    const r = cli(['init'])
    assert(r.code === 0, `exit ${r.code}: ${r.err || r.out}`)
    assert(readFileSync(join(DIR, 'boxlite.toml'), 'utf8') === before, 'init rewrote boxlite.toml')
    assert(readFileSync(join(DIR, '.boxlite/link.json'), 'utf8').includes(APP), 'link.json missing the app')
  })
  await check('check passes on the fixture', async () => {
    const r = cli(['check'])
    assert(r.code === 0, `exit ${r.code}: ${r.err || r.out}`)
    return `${r.json?.warnings?.length ?? 0} warnings`
  })
  await check('check catches a typo with file and line', async () => {
    setToml((s) => s.replace('health = "/healthz"', 'healthcheck = "/healthz"'))
    const r = cli(['check'])
    setToml((s) => s.replace('healthcheck = "/healthz"', 'health = "/healthz"'))
    assert(r.code === 7, `exit ${r.code}`)
    const e = r.json?.errors?.[0]
    assert(e?.line && e?.rule, `no line/rule: ${JSON.stringify(r.json).slice(0, 200)}`)
    return `${e.rule} at line ${e.line}`
  })
  await check('plan lists database, volume, auth, schedule, variables, secrets', async () => {
    const r = cli(['plan'])
    assert(r.code === 0, `exit ${r.code}: ${r.err}`)
    const paths = (r.json?.changes ?? []).map((c) => c.path).join(' ')
    for (const k of ['database', 'volume', 'auth', 'schedule', 'variables', 'secrets']) assert(paths.includes(k), `missing ${k} in ${paths}`)
    return `${r.json.changes.length} changes`
  })

  // ---- deploy ----------------------------------------------------------------------
  let first = 0
  await check('first deploy goes live (upload → build → migrate → start)', async () => {
    const r = cli(['deploy', '-m', 'e2e first'])
    assert(r.code === 0, `exit ${r.code}: ${(r.err || r.out).slice(-600)}`)
    first = r.json?.deployment?.number ?? r.json?.number
    APP_URL = (r.json?.deployment?.url ?? r.json?.url ?? '').replace(/\/$/, '')
    assert(APP_URL.startsWith('https://'), `no app url in deploy result: ${JSON.stringify(r.json).slice(0, 200)}`)
    return `#${first} ${APP_URL}`
  })

  // ---- access --------------------------------------------------------------------
  await check('private app refuses anonymous visitors', async () => {
    const r = await app('/', { anonymous: true })
    assert(r.status === 401 || r.status === 302, `got ${r.status}`)
    return `${r.status}`
  })
  await check('the App key as a Bearer header opens the private app; a key in the URL does not', async () => {
    const page = await app('/')
    assert(page.status === 200 && (await page.text()).includes('Kitchen sink'), `page ${page.status}`)
    const viaUrl = await fetch(`${APP_URL}/?__key=${KEY}`, { redirect: 'manual' })
    assert(viaUrl.status === 401, `?__key still works: ${viaUrl.status}`)
    const other = await fetch(`${APP_URL}/`, { headers: { authorization: 'Bearer bxl_app_wrongwrongwrongwrongwrongwrong' }, redirect: 'manual' })
    assert(other.status === 401, `wrong key accepted: ${other.status}`)
    return 'ok'
  })
  await check('the app never sees the App key', async () => {
    const e = await (await app('/api/headers')).json()
    assert(!JSON.stringify(e).includes(KEY), 'App key reached the app')
  })

  // ---- runtime contract ------------------------------------------------------------
  await check('runtime env: BOXLITE_APP_URL, BOXLITE_ENV, variables, secret, prefix, build output', async () => {
    const e = await (await app('/api/env')).json()
    assert(e.app_url?.replace(/\/$/, '') === APP_URL, `app_url ${e.app_url} vs ${APP_URL}`)
    assert(e.env === 'main', `env ${e.env}`)
    assert(e.greeting === 'hello', `greeting ${e.greeting}`)
    assert(e.has_secret === true, 'secret not injected')
    assert(!e.prefix, `unexpected path prefix ${e.prefix}`)
    assert(e.build?.version === 'v1', `build ${JSON.stringify(e.build)}`)
    return 'all present'
  })
  await check('relative asset under the prefix is served', async () => {
    const r = await app('/app.js')
    assert(r.status === 200, `${r.status}`)
  })
  await check('database: app writes, CLI reads the same rows', async () => {
    const w = await app('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'first item' }) })
    assert(w.status === 201, `write ${w.status}`)
    const r = cli(['app', 'sql', 'select title from items'])
    assert(r.code === 0 && JSON.stringify(r.json).includes('first item'), `sql ${r.code} ${r.out.slice(0, 200)}`)
    return 'row visible'
  })
  await check('DDL on main is refused with a migration hint', async () => {
    const r = cli(['app', 'sql', 'drop table items'])
    assert(r.code === 5, `exit ${r.code}`)
    assert(/migrations/.test(r.err + r.out), 'no migrations hint')
  })
  await check('read-only SQL cannot write without --write', async () => {
    const r = cli(['app', 'sql', "insert into items(title) values ('x')"])
    assert(r.code !== 0, 'insert succeeded without --write')
    const w = cli(['app', 'sql', "insert into items(title) values ('via cli')", '--write'])
    assert(w.code === 0, `--write failed: ${w.err}`)
  })
  await check('volume: upload survives and is listed', async () => {
    const w = await app('/api/files?name=hello.txt', { method: 'PUT', body: 'hi there' })
    assert(w.status === 201, `upload ${w.status}`)
    const l = await (await app('/api/files')).json()
    assert(l.includes('hello.txt'), `list ${JSON.stringify(l)}`)
  })

  // ---- sign-in ---------------------------------------------------------------------
  await check('protected path asks anonymous browsers to sign in', async () => {
    const r = await app('/api/me', { headers: { accept: 'text/html' } })
    assert(r.status === 302 && r.headers.get('location')?.includes('/.boxlite/auth/login'), `${r.status} ${r.headers.get('location')}`)
    const j = await app('/api/me')
    assert(j.status === 401, `api ${j.status}`)
    const start = await fetch(new URL(r.headers.get('location'), APP_URL), { redirect: 'manual' })
    const gh = await fetch(new URL(start.headers.get('location'), APP_URL), { redirect: 'manual' })
    assert(/github\.com\/login\/oauth\/authorize/.test(gh.headers.get('location') ?? start.headers.get('location') ?? ''), `login does not reach GitHub: ${start.status} ${start.headers.get('location')}`)
  })
  await check('test session carries identity headers to the app and mirrors the user', async () => {
    const t = cli(['app', 'auth', 'test-session', '--email', 'e2e@example.com'])
    assert(t.code === 0, `exit ${t.code} ${t.err}`)
    const me = await app('/api/me', { headers: { cookie: t.json.cookie } })
    const b = await me.json()
    assert(b.email === 'e2e@example.com', `me ${JSON.stringify(b)}`)
    const u = cli(['app', 'sql', "select email from boxlite.users where email = 'e2e@example.com'"])
    assert(JSON.stringify(u.json).includes('e2e@example.com'), 'not mirrored')
  })
  await check('forged identity headers are stripped', async () => {
    const r = await app('/api/me', { headers: { 'x-boxlite-user-id': 'evil', 'x-boxlite-user-email': 'evil@x', 'x-boxlite-identity': 'forged' } })
    assert(r.status === 401, `forged accepted: ${r.status}`)
  })
  await check('supervisor control API is unreachable through the app URL', async () => {
    for (const p of ['/.boxlite/sv/health', '/.boxlite/sv/restart', '/%2eboxlite/sv/logs']) {
      const r = await app(p, { method: p.endsWith('restart') ? 'POST' : 'GET' })
      assert(r.status === 404, `${p} → ${r.status}`)
    }
  })

  // ---- observability ---------------------------------------------------------------
  await check('logs: service output is collected', async () => {
    const r = await until(() => { const x = cli(['app', 'logs', '--source', 'web', '--limit', '200']); return x.out.includes('listening') || x.out.includes('created item') ? x : null }, { what: 'web logs' })
    return `${r.out.split('\n').length} lines`
  })
  await check('status shows the live deployment and healthy service', async () => {
    const s = cli(['app', 'status'])
    const t = JSON.stringify(s.json)
    assert(t.includes('live'), `status ${t.slice(0, 300)}`)
    const v = cli(['app', 'services'])
    assert(JSON.stringify(v.json).includes('healthy'), `services ${v.out.slice(0, 300)}`)
  })
  await check('schedule fires on time and is logged', async () => {
    const n = await until(async () => { const x = await (await app('/api/ticks')).json(); return x.n >= 1 ? x.n : null }, { timeoutMs: 150_000, everyMs: 10_000, what: 'a schedule tick' })
    const l = cli(['app', 'logs', '--source', 'schedule', '--limit', '20'])
    assert(l.out.includes('tick'), `schedule log missing: ${l.out.slice(0, 200)}`)
    return `${n} ticks`
  })
  await check('crashed service is restarted and the app keeps serving', async () => {
    await app('/api/crash', { method: 'POST' })
    await until(async () => (await app('/healthz')).status === 200, { what: 'recovery' })
    const v = await until(() => { const x = cli(['app', 'services']); return /restarts"?:\s*[1-9]/.test(x.out) ? x : null }, { what: 'restart count' })
    return 'restarted'
  })

  // ---- change, fail, roll back ----------------------------------------------------
  let good = 0
  await check('second deploy with a changed variable rebuilds', async () => {
    setToml((s) => s.replace('GREETING = "hello"', 'GREETING = "hello"\nAPP_VERSION = "v2"'))
    const r = cli(['deploy', '-m', 'e2e v2'])
    assert(r.code === 0, `exit ${r.code} ${(r.err || r.out).slice(-400)}`)
    good = r.json?.deployment?.number ?? r.json?.number
    const e = await (await app('/api/env')).json()
    assert(e.build?.version === 'v2', `build ${JSON.stringify(e.build)}`)
    return `#${good}`
  })
  await check('a broken deploy fails with a classified cause and the old version keeps serving', async () => {
    setToml((s) => s.replace('health = "/healthz"', 'health = "/nope"'))
    const r = cli(['deploy', '-m', 'e2e broken'])
    setToml((s) => s.replace('health = "/nope"', 'health = "/healthz"'))
    assert(r.code === 8, `exit ${r.code}`)
    const e = await (await app('/api/env')).json()
    assert(e.build?.version === 'v2', 'old version not serving')
    return (r.json?.error?.message ?? r.err).slice(0, 120)
  })
  await check('rollback to the first deployment', async () => {
    const r = cli(['app', 'rollback', String(first), '--yes'])
    assert(r.code === 0, `exit ${r.code} ${r.err}`)
    const e = await (await app('/api/env')).json()
    assert(e.build?.version === 'v1', `after rollback ${JSON.stringify(e.build)}`)
    const items = cli(['app', 'sql', 'select count(*) as n from items'])
    assert(JSON.stringify(items.json).match(/\[\s*\[?\s*"?[1-9]/), 'data lost on rollback')
    return 'code back, data kept'
  })
  await check('deployment history explains every change', async () => {
    const r = cli(['app', 'deployments'])
    const t = JSON.stringify(r.json)
    for (const s of ['e2e first', 'e2e v2', 'e2e broken', 'Roll back']) assert(t.includes(s), `missing "${s}"`)
  })

  // ---- sleep and wake --------------------------------------------------------------
  await check('stopped Box wakes on the next request with a starting page, not a 502', async () => {
    const st = cli(['app', 'status']).json
    const boxId = st?.envs?.find((e) => e.name === 'main')?.box_id ?? JSON.stringify(st).match(/"box(?:_id)?":"([A-Za-z0-9]{12})"/)?.[1]
    assert(boxId, `no box id in status: ${JSON.stringify(st).slice(0, 300)}`)
    const env = Object.fromEntries(readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    await fetch(`https://api.dev.boxlite.ai/v1/boxes/${boxId}/stop`, { method: 'POST', headers: { authorization: `Bearer ${env.BOXLITE_API_KEY}`, 'content-length': '0' } })
    await sleep(5000)
    const seen = new Set()
    await until(async () => { const r = await app('/healthz'); seen.add(r.status); assert(r.status !== 502, 'got 502'); return r.status === 200 }, { timeoutMs: 120_000, everyMs: 2000, what: 'wake' })
    return [...seen].join(' → ')
  })

  // ---- environments ----------------------------------------------------------------
  await check('staging forks main: schema yes, rows no; then delete', async () => {
    const c = cli(['app', 'env', 'create', 'staging', '--from', 'main'])
    assert(c.code === 0, `create ${c.code} ${c.err}`)
    const r = cli(['app', 'sql', 'select count(*) as n from items', '--env', 'staging'])
    assert(r.code === 0 && /"?0"?/.test(JSON.stringify(r.json?.rows)), `staging rows ${JSON.stringify(r.json)}`)
    const d = cli(['app', 'env', 'delete', 'staging', '--yes'])
    assert(d.code === 0, `delete ${d.code} ${d.err}`)
  })

  // ---- context for agents ----------------------------------------------------------
  await check('app context gives an agent everything in one call', async () => {
    const r = cli(['app', 'context', '--format', 'markdown'], { json: false })
    for (const k of ['items', 'uploads', 'web', 'tick', 'GREETING']) assert(r.out.includes(k), `context missing ${k}`)
    assert(!r.out.includes('s3cr3t-value') && !r.out.includes('npg_'), 'context leaks a secret')
    return `${r.out.length} chars`
  })
}

async function cleanup() {
  if (KEEP || !KEY) return
  const r = await fetch(`${CP}/v1/apps/${APP}?purge=1`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
  console.log(`cleanup: DELETE app → ${r.status}`)
  if (DIR) rmSync(DIR, { recursive: true, force: true })
}

try { await main() } finally {
  await cleanup()
  const ok = results.filter((r) => r.ok).length
  const md = [`# Live e2e — ${new Date().toISOString()}`, '', `CP ${CP} · app ${APP} · ${ok}/${results.length} passed`, '', '| | check | time | detail |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.ok ? '✔' : '✖'} | ${r.name} | ${(r.ms / 1000).toFixed(1)}s | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 160)} |`)].join('\n')
  writeFileSync(join(ROOT, 'e2e/report.md'), md + '\n')
  console.log(`\n${ok}/${results.length} passed · e2e/report.md`)
  process.exitCode = ok === results.length ? 0 : 1
}
