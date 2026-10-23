#!/usr/bin/env node
// The error matrix: breaks one App on a real control plane in each way an agent's code can, and
// checks that the CLI hands the agent what it needs to fix it by itself: the exit code, a classified
// cause, a fix that names a command or a file, the app's own error line as evidence, and (for a
// failed deploy) the previous version still serving.
//
//   ADMIN_TOKEN=… node e2e/errors-live.mjs            # CP_URL defaults to the dev control plane
//
// Writes e2e/errors-report.md (one row per scenario) and exits 1 if any scenario fails.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = (process.env.CP_URL ?? 'https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai').replace(/\/+$/, '')
const ADMIN = process.env.ADMIN_TOKEN ?? readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const CLI = process.env.CLI ?? join(ROOT, 'cli/dist/boxlite-app.cjs')
const APP = process.env.APP ?? `errors-${Date.now().toString(36).slice(-5)}`
const DIR = mkdtempSync(join(tmpdir(), 'errors-live-'))
let KEY = ''
let URL_ = ''

const rows = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cli(args, { input, json = true } = {}) {
  const r = spawnSync('node', [CLI, ...args, ...(json ? ['--json'] : [])], {
    cwd: DIR, encoding: 'utf8', input, timeout: 15 * 60_000,
    env: { ...process.env, BOXLITE_API_URL: CP, BOXLITE_API_KEY: KEY },
  })
  let out = null
  try { out = JSON.parse(r.stdout) } catch { try { out = JSON.parse(r.stderr) } catch { /* human output */ } }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr }
}

const file = (name) => join(DIR, name)
const read = (name) => readFileSync(file(name), 'utf8')
const write = (name, text) => writeFileSync(file(name), text)
const edit = (name, f) => write(name, f(read(name)))
const app = (path, init = {}) => fetch(`${URL_}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) } })

/** Snapshot of the project so each broken deploy starts from the good version. */
let good = null
const saveGood = () => { good = Object.fromEntries(['boxlite.toml', 'server.js', 'package.json', 'package-lock.json', 'migrations/0001_init.sql'].map((f) => [f, read(f)])) }
const restore = () => { for (const [f, t] of Object.entries(good)) write(f, t); rmSync(file('migrations/0002_bad.sql'), { force: true }) }

/** One row: what the agent would see, and whether it is enough to act on. */
async function scenario(name, expect, run) {
  const t0 = Date.now()
  const row = { name, expect, ok: false, saw: '', secs: 0 }
  try {
    row.saw = await run()
    row.ok = true
    console.log(`  ✔ ${name}  ${row.saw}`)
  } catch (e) {
    row.saw = String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 400)
    console.log(`  ✖ ${name}  ${row.saw}`)
  }
  row.secs = Math.round((Date.now() - t0) / 1000)
  rows.push(row)
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

/** A failed deploy: exit 8, the cause, a fix naming a command or file, the app's own line, old version serving. */
async function brokenDeploy({ cause, evidence, fixMentions }) {
  const r = cli(['deploy', '-m', `break: ${cause}`])
  const e = r.out?.error ?? {}
  const summary = `exit ${r.code} · cause ${e.cause} · fix: ${(e.fix ?? '').slice(0, 140)}`
  assert(r.code === 8, `expected exit 8, got ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`)
  assert(e.cause === cause, `cause ${e.cause}, expected ${cause}. ${summary} · evidence: ${JSON.stringify(e.evidence ?? [])} · tail: ${JSON.stringify((e.log_tail ?? []).slice(-8))}`)
  assert(e.fix && /boxlite-app|\.toml|\.sql|\.js|package/.test(e.fix), `fix names no command or file: ${e.fix}`)
  const shown = [...(e.evidence ?? []), ...(e.log_tail ?? [])].join('\n')
  assert(evidence.test(shown), `the app's own error is not in evidence/log_tail: ${shown.slice(-300)}`)
  if (fixMentions) assert(fixMentions.test(e.fix + (e.file ?? '')), `fix does not point at ${fixMentions}: ${e.fix} ${e.file ?? ''}`)
  const page = await app('/')
  assert(page.status === 200 && (await page.text()).startsWith('errors v'), `the last good version is not serving (${page.status})`)
  restore()
  return summary
}

async function main() {
  console.log(`Error matrix · CP ${CP} · app ${APP}`)
  const created = await fetch(`${CP}/v1/apps`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: APP }) })
  const body = await created.text()
  assert(created.status === 201, `create app: ${created.status} ${body}`)
  KEY = JSON.parse(body).key
  cpSync(join(ROOT, 'e2e/fixtures/errors'), DIR, { recursive: true })
  edit('boxlite.toml', (s) => s.replace('name = "errors"', `name = "${APP}"`))
  const init = cli(['init'])
  assert(init.code === 0, `init: ${init.stderr}`)

  try {
    await scenario('invalid boxlite.toml is caught before upload', 'check exits 7 naming the field and line', async () => {
      edit('boxlite.toml', (s) => s.replace('size  = "small"', 'size  = "small"\ncolour = "red"'))
      const r = cli(['check'])
      const err = r.out?.errors?.[0] ?? r.out?.error?.errors?.[0]
      edit('boxlite.toml', (s) => s.replace('\ncolour = "red"', ''))
      assert(r.code === 7, `exit ${r.code}`)
      assert(err && /colour/.test(err.message) && err.line, `no field or line: ${JSON.stringify(r.out).slice(0, 300)}`)
      return `exit 7 · ${err.rule} at boxlite.toml:${err.line}`
    })

    await scenario('the good version deploys', 'live, serving v1', async () => {
      const r = cli(['deploy', '-m', 'good'])
      assert(r.code === 0, `deploy exit ${r.code}: ${(r.stderr || r.stdout).slice(-400)}`)
      URL_ = (r.out?.url ?? r.out?.deployment?.url ?? '').replace(/\/$/, '')
      if (!URL_) URL_ = cli(['app', 'status']).out?.envs?.[0]?.url?.replace(/\/$/, '')
      assert(URL_, 'no app URL')
      assert((await app('/')).status === 200, 'not serving')
      saveGood()
      return URL_
    })

    await scenario('a build step fails (type error)', 'build_command_failed, the compiler line as evidence', () => {
      edit('boxlite.toml', (s) => s.replace('build = ["npm ci"]', `build = ["npm ci", "node -e \\"console.error('src/cart.ts(3,5): error TS2322: Type string is not assignable to type number'); process.exit(2)\\""]`))
      return brokenDeploy({ cause: 'build_command_failed', evidence: /TS2322/ })
    })

    await scenario('a build script that does not exist', 'npm_script_missing, names the script', () => {
      edit('boxlite.toml', (s) => s.replace('build = ["npm ci"]', 'build = ["npm ci", "npm run build"]'))
      return brokenDeploy({ cause: 'npm_script_missing', evidence: /build/, fixMentions: /package\.json|scripts|build/ })
    })

    await scenario('no lockfile for npm ci', 'missing_lockfile', () => {
      rmSync(file('package-lock.json'))
      return brokenDeploy({ cause: 'missing_lockfile', evidence: /package-lock|lockfile|npm ci/i })
    })

    await scenario('a module that is not installed', 'module_not_found, names the module', () => {
      edit('server.js', (s) => `require('left-pad-xyz')\n${s}`)
      return brokenDeploy({ cause: 'module_not_found', evidence: /left-pad-xyz/, fixMentions: /left-pad-xyz/ })
    })

    // Binding 127.0.0.1 works here (traffic reaches the app from inside its own Box); a hard-coded
    // port does not, because the platform picks PORT.
    await scenario('a hard-coded port instead of $PORT', 'port_binding, names both ports', () => {
      edit('server.js', (s) => s.replace("server.listen(Number(process.env.PORT), '0.0.0.0')", "server.listen(3000, '0.0.0.0', () => console.log('listening on port 3000'))"))
      return brokenDeploy({ cause: 'port_binding', evidence: /3000|listen/, fixMentions: /process\.env\.PORT|\$PORT/ })
    })

    await scenario('a crash at startup', 'crash_on_start, the thrown message as evidence', () => {
      edit('server.js', (s) => `throw new Error('startup-marker: config.json is malformed at line 3')\n${s}`)
      return brokenDeploy({ cause: 'crash_on_start', evidence: /startup-marker/ })
    })

    await scenario('a migration with a SQL error', 'migration_sql_error, names the file', () => {
      write('migrations/0002_bad.sql', 'CREATE TABLE refunds (id serial PRIMARY KEY,, amount numeric);\n')
      return brokenDeploy({ cause: 'migration_sql_error', evidence: /syntax|0002_bad/, fixMentions: /0002_bad\.sql/ })
    })

    await scenario('an applied migration edited afterwards', 'migration_changed, says to add a new one', async () => {
      edit('migrations/0001_init.sql', (s) => s.replace('total numeric NOT NULL', 'total numeric NOT NULL, note text'))
      const r = cli(['deploy', '-m', 'edit an applied migration'])
      const e = r.out?.error ?? {}
      restore()
      assert(r.code !== 0, 'an edited applied migration deployed')
      assert(/migration_changed/.test(`${e.cause} ${e.code} ${JSON.stringify(e.errors ?? '')}`), `not classified: ${JSON.stringify(e).slice(0, 300)}`)
      assert(/migration new|new migration|0002|new file/i.test(e.fix ?? e.next ?? ''), `fix does not say to add a migration: ${e.fix ?? e.next}`)
      return `exit ${r.code} · ${e.cause ?? e.code} · ${(e.fix ?? e.next ?? '').slice(0, 120)}`
    })

    await scenario('a request that throws', 'the stack reaches app logs and app context', async () => {
      await app('/boom').catch(() => undefined)
      let line = ''
      for (let i = 0; i < 20 && !line; i++) {
        await sleep(3000)
        const logs = cli(['app', 'logs', '--level', 'error', '--since', '5m'])
        line = JSON.stringify(logs.out ?? '').match(/boom-marker[^"\\]*/)?.[0] ?? ''
      }
      assert(line, 'the thrown error never reached `app logs --level error`')
      const ctx = cli(['app', 'context', '--format', 'json'], { json: false })
      const c = JSON.parse(ctx.stdout)
      assert(JSON.stringify(c.recent_errors).includes('boom-marker'), 'app context has no recent error for it')
      return `logs: "${line.slice(0, 60)}" · context.recent_errors has it`
    })

    await scenario('a crash after go-live', 'services shows the restart and exit code; logs have the reason', async () => {
      await app('/crash').catch(() => undefined)
      let svc = null
      for (let i = 0; i < 20; i++) {
        await sleep(3000)
        svc = cli(['app', 'services']).out?.find?.((s) => s.name === 'web')
        if (svc?.restarts >= 1) break
      }
      assert(svc?.restarts >= 1 && svc.last_exit_code === 1, `services: ${JSON.stringify(svc)}`)
      const logs = JSON.stringify(cli(['app', 'logs', '--since', '5m']).out ?? '')
      assert(/crash-marker/.test(logs), 'the crash reason is not in app logs')
      for (let i = 0; i < 20 && (await app('/').catch(() => ({ status: 0 }))).status !== 200; i++) await sleep(2000)
      return `restarts ${svc.restarts}, last exit ${svc.last_exit_code}, reason in logs`
    })

    await scenario('a scheduled job that fails', 'schedule list shows the failure; logs have the job output', async () => {
      edit('boxlite.toml', (s) => `${s}\n[[schedule]]\nname   = "digest"\ncron   = "* * * * *"\ntarget = "web:/jobs/fail"\n`)
      const d = cli(['deploy', '-m', 'add a failing job'])
      assert(d.code === 0, `deploy exit ${d.code}`)
      const run = cli(['app', 'schedule', 'run', 'digest'])
      const list = cli(['app', 'schedule', 'list']).out?.find?.((s) => s.name === 'digest')
      const logs = JSON.stringify(cli(['app', 'logs', '--since', '5m']).out ?? '')
      edit('boxlite.toml', (s) => s.replace(/\n\[\[schedule\]\][\s\S]*$/, '\n'))
      assert(run.out?.status === 500 || list?.last_status === 500, `the failure is not reported: run ${JSON.stringify(run.out)} list ${JSON.stringify(list)}`)
      assert(/job-marker/.test(logs), 'the job output is not in app logs')
      return `run → ${run.out?.status}, list last_status ${list?.last_status}, output in logs`
    })

    await scenario('the app runs out of memory', 'services/context say it was killed for memory, not a plain crash', async () => {
      await app('/oom').catch(() => undefined)
      let svc = null
      for (let i = 0; i < 30; i++) {
        await sleep(3000)
        svc = cli(['app', 'services']).out?.find?.((s) => s.name === 'web')
        if (svc?.restarts >= 2 || (svc?.last_exit_code ?? 0) >= 128) break
      }
      const ctx = JSON.parse(cli(['app', 'context', '--format', 'json'], { json: false }).stdout)
      const said = JSON.stringify(ctx.next_actions) + JSON.stringify(ctx.recent_errors)
      assert(/memory|oom|137/i.test(said), `nothing says memory: exit ${svc?.last_exit_code}; next_actions ${JSON.stringify(ctx.next_actions).slice(0, 300)}`)
      return `exit ${svc?.last_exit_code}; context names memory`
    })
  } finally {
    const del = await fetch(`${CP}/v1/apps/${APP}`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } })
    console.log(`cleanup: DELETE app → ${del.status}`)
    rmSync(DIR, { recursive: true, force: true })
  }

  const passed = rows.filter((r) => r.ok).length
  const md = [
    `# Error matrix · ${new Date().toISOString()}`,
    '',
    `CP ${CP} · ${passed}/${rows.length} scenarios give the agent what it needs`,
    '',
    '| | scenario | expected | what the CLI returned | s |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.ok ? '✔' : '✖'} | ${r.name} | ${r.expect} | ${r.saw.replace(/\|/g, '\\|')} | ${r.secs} |`),
  ].join('\n')
  writeFileSync(join(ROOT, 'e2e/errors-report.md'), md + '\n')
  console.log(`\n${passed}/${rows.length} passed · e2e/errors-report.md`)
  process.exit(passed === rows.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
