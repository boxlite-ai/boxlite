#!/usr/bin/env node
// A Python app on a live control plane, written the way agents write one (e2e/fixtures/python):
// pip installs gunicorn and psycopg in the build, the service starts `gunicorn` by its bare name,
// and psycopg connects with DATABASE_URL exactly as the platform gives it. Then a command nothing
// installed must fail as command_not_found with a fix.
//
//   node e2e/python-live.mjs        (CP_URL, ADMIN_TOKEN, CLI as in run-live.mjs)
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = (process.env.CP_URL ?? 'https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai').replace(/\/+$/, '')
const ADMIN = process.env.ADMIN_TOKEN ?? readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const CLI = process.env.CLI ?? join(ROOT, 'cli/dist/boxlite-app.cjs')
const APP = process.env.APP ?? `py-${Date.now().toString(36).slice(-5)}`
const DIR = mkdtempSync(join(tmpdir(), 'python-live-'))
let KEY = ''
let URL_ = ''
const results = []

function cli(args) {
  const r = spawnSync('node', [CLI, ...args, '--json'], { cwd: DIR, encoding: 'utf8', timeout: 20 * 60_000, env: { ...process.env, BOXLITE_API_URL: CP, BOXLITE_API_KEY: KEY } })
  let out = null
  try { out = JSON.parse(r.stdout) } catch { try { out = JSON.parse(r.stderr) } catch { /* human output */ } }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const app = (path) => fetch(`${URL_}${path}`, { headers: { authorization: `Bearer ${KEY}` } })

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const detail = (await fn()) ?? ''
    results.push({ name, ok: true })
    console.log(`  ✔ ${name}  ${detail}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  ✖ ${name}  ${e.message}`)
  }
}

async function main() {
  console.log(`Python · CP ${CP} · app ${APP}`)
  const created = await fetch(`${CP}/v1/apps`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: APP }) })
  const body = await created.text()
  assert(created.status === 201, `create app: ${created.status} ${body}`)
  KEY = JSON.parse(body).key
  cpSync(join(ROOT, 'e2e/fixtures/python'), DIR, { recursive: true })
  const toml = join(DIR, 'boxlite.toml')
  writeFileSync(toml, readFileSync(toml, 'utf8').replace('name = "python"', `name = "${APP}"`))
  assert(cli(['init', '--app', APP]).code === 0, 'init failed')

  await check('pip-installed gunicorn starts by its bare name', async () => {
    const r = cli(['deploy', '-m', 'python'])
    assert(r.code === 0, `deploy exit ${r.code}: ${JSON.stringify(r.out?.error ?? r.stderr).slice(0, 600)}`)
    URL_ = (cli(['app', 'status']).out?.url ?? '').replace(/\/+$/, '')
    const page = await app('/')
    assert(page.status === 200 && (await page.text()) === 'python ok', `page ${page.status}`)
    return URL_
  })

  await check('psycopg connects with DATABASE_URL as given (verify-full, system CA)', async () => {
    const r = await app('/db')
    const text = await r.text()
    assert(r.status === 200 && /^\d+$/.test(text), `/db ${r.status}: ${text.slice(0, 300)}`)
    return `${text} visit(s)`
  })

  await check('a command nothing installed fails as command_not_found, and the last version keeps serving', async () => {
    writeFileSync(toml, readFileSync(toml, 'utf8').replace('command = "gunicorn -b 0.0.0.0:$PORT app:app"', 'command = "uvicorn app:app --port $PORT"'))
    const r = cli(['deploy', '-m', 'uvicorn without installing it'])
    const e = r.out?.error ?? {}
    assert(r.code === 8 && e.cause === 'command_not_found', `exit ${r.code} cause ${e.cause}: ${JSON.stringify(e).slice(0, 400)}`)
    assert(/uvicorn/.test(e.summary ?? e.message ?? '') && /requirements\.txt/.test(e.fix), `summary/fix: ${e.summary} · ${e.fix}`)
    const page = await app('/')
    assert(page.status === 200, `the last good version is not serving (${page.status})`)
    return e.summary ?? e.message
  })
}

try { await main() } catch (e) { results.push({ name: 'setup', ok: false }); console.log(`  ✖ setup  ${e.message}`) } finally {
  if (KEY) {
    const r = await fetch(`${CP}/v1/apps/${APP}?purge=1`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    console.log(`cleanup: purge → ${r.status}`)
  }
  rmSync(DIR, { recursive: true, force: true })
  const ok = results.filter((r) => r.ok).length
  console.log(`\n${ok}/${results.length} passed`)
  process.exitCode = ok === results.length ? 0 : 1
}
