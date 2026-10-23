#!/usr/bin/env node
// Independent check of what each acceptance agent built. It ignores the agent's own report and
// looks from the outside, the way the user would: the app URL, then the console API (the same
// data the console pages render).
//
//   node e2e/verify-acceptance.mjs            reads e2e/acceptance/*.app.json
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = process.env.CP_URL ?? 'https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai'
const CONSOLE = process.env.CONSOLE_URL ?? CP.replace(/^https:\/\/8080-/, 'https://8081-')
const ADMIN = readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const DIR = join(ROOT, 'e2e/acceptance')

const login = await fetch(`${CONSOLE}/console/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: ADMIN, next: '/console/' }) })
const consoleCookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
const consoleApi = async (path, init = {}) => {
  const r = await fetch(`${CONSOLE}/console/api${path}`, { ...init, headers: { cookie: consoleCookie, 'x-boxlite-console': '1', origin: CONSOLE, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** Per-case: what the page must show for the request to count as done. */
const EXPECT = {
  m1: { page: [/<form/i], needs: ['database'] },
  m2: { page: [/type=["']?file/i], needs: ['volume'] },
  m3: { page: [/\.boxlite\/auth\/login|github/i], needs: ['database', 'auth'] },
  m4: { page: [/\.boxlite\/auth\/login|github/i], needs: ['database', 'auth', 'volume', 'schedule', 'test env'] },
}

const rows = []
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.app.json'))) {
  const c = JSON.parse(readFileSync(join(DIR, f), 'utf8'))
  const exp = EXPECT[c.id] ?? { page: [], needs: [] }
  const checks = []
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
  const status = await (await fetch(`${CP}/v1/apps/${c.app}`, { headers: { authorization: `Bearer ${c.key}` } })).json()
  const main = status.envs?.find((e) => e.name === 'main')
  check('app is live', main?.status?.startsWith('live'), main?.status)
  const url = main?.url
  const page = url ? await fetch(url, { headers: { authorization: `Bearer ${c.key}`, accept: 'text/html' }, redirect: 'manual' }) : null
  const html = page ? await page.text() : ''
  const pageOk = page?.status === 200 || (c.id === 'm3' && page?.status === 302)
  check('app URL answers with a real page', pageOk, `${page?.status} ${html.length} bytes`)
  for (const re of exp.page) check(`page shows ${re}`, re.test(html) || (page?.status === 302 && /login/.test(page.headers.get('location') ?? '')), '')
  const spec = await (await fetch(`${CP}/v1/apps/${c.app}/envs/main/spec`, { headers: { authorization: `Bearer ${c.key}` } })).json()
  if (exp.needs.includes('database')) check('declared a database', spec?.database, '')
  if (exp.needs.includes('volume')) check('declared a volume', spec?.volumes?.length, JSON.stringify(spec?.volumes?.map((v) => v.mount)))
  if (exp.needs.includes('auth')) check('declared GitHub sign-in', spec?.auth?.providers?.includes('github'), JSON.stringify(spec?.auth))
  if (exp.needs.includes('schedule')) check('declared a weekly schedule', spec?.schedules?.length, JSON.stringify(spec?.schedules?.map((x) => x.cron)))
  if (exp.needs.includes('test env')) check('tried it in a test environment first', status.envs?.some((e) => e.name !== 'main'), JSON.stringify(status.envs?.map((e) => `${e.name}:${e.status}`)))

  // Console side: the same calls the console pages make.
  const d = await consoleApi(`/apps/${c.app}?env=main`)
  check('console shows the app Running', d.status === 200 && /live|running/i.test(JSON.stringify(d.body?.status ?? '')), d.body?.status)
  check('console lists a live deployment', (d.body?.releases ?? []).some((r) => /active|live|current/i.test(JSON.stringify(r))), `${d.body?.releases?.length ?? 0} deployments`)
  if (spec?.database) {
    const db = await consoleApi(`/apps/${c.app}/database?env=main`)
    const tables = (db.body?.tables ?? db.body?.database?.tables ?? []).filter((t) => !/boxlite/.test(t.name ?? t.schema ?? ''))
    check('console database shows the app tables', tables.length > 0, tables.map((t) => `${t.name}(${t.rows})`).join(', '))
    const sql = await consoleApi(`/apps/${c.app}/sql?env=main`, { method: 'POST', body: JSON.stringify({ query: 'select 1 as ok' }) })
    check('console SQL console runs a query', sql.status === 200, JSON.stringify(sql.body).slice(0, 80))
  }
  if (spec?.volumes?.length) check('console shows the volume', (d.body?.storages ?? []).length > 0, (d.body?.storages ?? []).map((s) => s.name).join(','))
  if (spec?.auth) {
    const a = await consoleApi(`/apps/${c.app}/auth?env=main`)
    check('console auth shows GitHub ready', JSON.stringify(a.body).includes('github'), '')
  }
  const logs = await consoleApi(`/apps/${c.app}/logs?env=main`)
  check('console logs show the app output', JSON.stringify(logs.body ?? '').length > 200, '')
  rows.push({ id: c.id, app: c.app, url, ask: c.ask, checks })
}

const md = ['# Acceptance — independent verification', '']
for (const r of rows) {
  const ok = r.checks.filter((c) => c.ok).length
  md.push(`## ${r.id} · ${r.app} · ${ok}/${r.checks.length}`, '', `> ${r.ask}`, '', r.url ?? '', '', ...r.checks.map((c) => `- ${c.ok ? '✔' : '✖'} ${c.name} ${c.detail ? `— ${String(c.detail).slice(0, 140)}` : ''}`), '')
}
writeFileSync(join(DIR, 'verification.md'), md.join('\n'))
console.log(md.join('\n'))
