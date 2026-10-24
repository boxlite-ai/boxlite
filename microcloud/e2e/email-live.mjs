#!/usr/bin/env node
// Email code sign-in on the live dev control plane (docs/email-sign-in.md). The agent sets the App's
// mail sender with the real CLI (the dev SMTP sink on the CP's Box, deploy/smtp-sink.mjs), and a
// visitor signs in through the real login page with the code the sink received.
//
//   node e2e/email-live.mjs        (CP_URL, ADMIN_TOKEN, CLI as in run-live.mjs; `boxlite` CLI for the sink)
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = (process.env.CP_URL ?? 'https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai').replace(/\/+$/, '')
const ADMIN = process.env.ADMIN_TOKEN ?? readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const CLI = process.env.CLI ?? join(ROOT, 'cli/dist/boxlite-app.cjs')
const APP = process.env.APP ?? `mail-${Date.now().toString(36).slice(-5)}`
const DIR = mkdtempSync(join(tmpdir(), 'email-live-'))
const VISITOR = `visitor-${Date.now().toString(36)}@e2e.test`
const OWNER = `owner.${Date.now().toString(36)}@owner.e2e.test`
let KEY = ''
let URL_ = ''
const results = []

function cli(args, input) {
  const r = spawnSync('node', [CLI, ...args, '--json'], { cwd: DIR, input, encoding: 'utf8', timeout: 20 * 60_000, env: { ...process.env, BOXLITE_API_URL: CP, BOXLITE_API_KEY: KEY } })
  let out = null
  try { out = JSON.parse(r.stdout) } catch { try { out = JSON.parse(r.stderr) } catch { /* human output */ } }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

/** The newest mail the sink on the CP's Box kept for `to`. */
function sinkMail(to) {
  const r = spawnSync('boxlite', ['--url', 'https://dev.boxlite.ai/api', 'exec', 'microcloud-cp', '--', 'sh', '-c', `f=$(ls -t /home/boxlite/cp/data/smtp-sink/*-${to}.eml 2>/dev/null | head -1); [ -n "$f" ] && cat "$f"`], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, BOXLITE_HOME: '/tmp/blhome-dev' } })
  return r.stdout ?? ''
}

/** One visitor's browser: keeps cookies between requests, never follows redirects. */
function browser() {
  const jar = new Map()
  const keep = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=')
      if (v) jar.set(k, v)
      else jar.delete(k)
    }
    return res
  }
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  return {
    get: async (path) => keep(await fetch(`${URL_}${path}`, { redirect: 'manual', headers: { cookie: cookie(), accept: 'text/html' } })),
    post: async (path, fields) => keep(await fetch(`${URL_}${path}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields), headers: { cookie: cookie(), origin: URL_, 'content-type': 'application/x-www-form-urlencoded' } })),
  }
}

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
  console.log(`Email sign-in · CP ${CP} · app ${APP}`)
  const created = await fetch(`${CP}/v1/apps`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: APP }) })
  const body = await created.text()
  assert(created.status === 201, `create app: ${created.status} ${body}`)
  KEY = JSON.parse(body).key
  cpSync(join(ROOT, 'e2e/fixtures/email'), DIR, { recursive: true })
  const toml = join(DIR, 'boxlite.toml')
  writeFileSync(toml, readFileSync(toml, 'utf8').replace('name = "email"', `name = "${APP}"`))
  assert(cli(['init', '--app', APP]).code === 0, 'init failed')

  await check('without a sender, plan says what is missing and the agent is told how to set it', async () => {
    const plan = cli(['plan'])
    const w = (plan.out?.warnings ?? []).find((x) => x.rule === 'auth_provider_not_configured')
    assert(w && /app auth email set/.test(w.message), `plan warnings: ${JSON.stringify(plan.out?.warnings)}`)
    const r = cli(['deploy', '-m', 'email sign-in'])
    assert(r.code === 0, `deploy exit ${r.code}: ${JSON.stringify(r.out?.error ?? r.stderr).slice(0, 400)}`)
    URL_ = (cli(['app', 'status']).out?.url ?? '').replace(/\/+$/, '')
    const ctx = cli(['app', 'context']).out
    assert(ctx.next_actions.some((f) => f.id === 'email_sender_missing'), `next_actions ${JSON.stringify(ctx.next_actions.map((f) => f.id))}`)
    return w.message
  })

  await check('the agent sets the sender (password from stdin) and a test email arrives', async () => {
    const set = cli(['app', 'auth', 'email', 'set', '--host', '127.0.0.1', '--port', '2525', '--username', 'sink', '--from', `${APP} <no-reply@e2e.test>`, '--password-stdin'], 'sink-password\n')
    assert(set.code === 0 && set.out?.password_set === true, `set: ${set.code} ${set.stderr.slice(0, 300)}`)
    assert(!set.stdout.includes('sink-password'), 'the password was printed')
    const t = cli(['app', 'auth', 'email', 'test', '--to', OWNER])
    assert(t.code === 0 && t.out?.sent, `test: ${t.code} ${t.stderr.slice(0, 300)}`)
    assert(/test of the sign-in email sender/.test(sinkMail(OWNER)), 'the test email is not in the sink')
    return `sent in ${t.out.ms} ms`
  })

  await check('a visitor gets a code by email and signs in on the real login page', async () => {
    const b = browser()
    const protectedPage = await b.get('/app')
    assert(protectedPage.status === 302 && /\/.boxlite\/auth\/login/.test(protectedPage.headers.get('location') ?? ''), `/app → ${protectedPage.status}`)
    const login = await b.get('/.boxlite/auth/login?next=/app')
    assert(login.status === 200 && /email\/start/.test(await login.text()), `login page ${login.status}`)
    const start = await b.post('/.boxlite/auth/email/start', { email: VISITOR, next: '/app' })
    assert(start.status === 200, `start ${start.status}: ${(await start.text()).slice(0, 200)}`)
    let code = ''
    for (let i = 0; i < 10 && !code; i++) {
      code = /code is (\d{6})/.exec(sinkMail(VISITOR))?.[1] ?? ''
      if (!code) await new Promise((r) => setTimeout(r, 1000))
    }
    assert(code, 'no code in the sink')
    const verify = await b.post('/.boxlite/auth/email/verify', { email: VISITOR, code, next: '/app' })
    assert(verify.status === 302 && verify.headers.get('location') === '/app', `verify ${verify.status}: ${(await verify.text()).slice(0, 200)}`)
    const app = await b.get('/app')
    const text = await app.text()
    assert(app.status === 200 && text === `hello ${VISITOR} via email`, `/app ${app.status}: ${text.slice(0, 200)}`)
    return text
  })

  await check('the owner sees the user, the provider ready, and the sign-in in the logs', async () => {
    const users = cli(['app', 'auth', 'users']).out ?? []
    assert(users.some((u) => u.email === VISITOR && u.provider === 'email'), `users ${JSON.stringify(users).slice(0, 300)}`)
    const st = cli(['app', 'auth', 'status']).out
    assert(st.providers.some((p) => p.name === 'email' && p.status === 'ready'), JSON.stringify(st.providers))
    const logs = cli(['app', 'logs', '--source', 'auth', '--since', '30m']).out
    const lines = JSON.stringify(logs)
    assert(lines.includes(`sign-in code sent to ${VISITOR}`) && lines.includes(`${VISITOR} signed in with email`), `auth logs: ${lines.slice(0, 400)}`)
    return 'user, status and logs agree'
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
