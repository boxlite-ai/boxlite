#!/usr/bin/env node
// Console end-to-end: drives the human console in headless Chromium against a real control plane
// while the real CLI deploys e2e/fixtures/kitchen-sink, and checks every tab against the CP's own
// API (read with the App key). It creates one App and purges it (Box, volumes, Neon) at the end.
//
//   CP_URL=https://8080-….proxy.dev.boxlite.ai ADMIN_TOKEN=… [APP=console-e2e] node e2e/console.spec.mjs
//
// CONSOLE_URL defaults to the console origin derived from CP_URL (port + 1). CLI defaults to
// cli/dist/boxlite-app.cjs. Screenshots go to docs/console-shots/v2/. KEEP=1 skips the purge.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = (process.env.CP_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const ADMIN = process.env.ADMIN_TOKEN ?? readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const APP = process.env.APP ?? `console-e2e-${Date.now().toString(36).slice(-5)}`
const CLI = process.env.CLI ?? join(ROOT, 'cli/dist/boxlite-app.cjs')
const SHOTS = join(ROOT, 'docs/console-shots/v2')
const CONSOLE = (process.env.CONSOLE_URL ?? consoleOrigin(CP)).replace(/\/+$/, '')
const APP_PAGE = `${CONSOLE}/console/dashboard/apps/${APP}`

/** The console's own origin: the API origin's port + 1 (local), or the tunnel host for port 8081. */
function consoleOrigin(cp) {
  const u = new URL(cp)
  if (['localhost', '127.0.0.1'].includes(u.hostname)) return `${u.protocol}//${u.hostname}:${Number(u.port || 80) + 1}`
  return `${u.protocol}//${u.hostname.replace(/^\d+-/, '8081-')}`
}

const results = []
let KEY = ''
let DIR = ''
let page
let shotN = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function step(name, fn) {
  const t0 = Date.now()
  try {
    const detail = (await fn()) ?? ''
    results.push({ name, ok: true, ms: Date.now() - t0, detail })
    console.log(`  ✔ ${name}  ${detail}`)
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: e.message.split('\n')[0] })
    console.log(`  ✖ ${name}  ${e.message.split('\n')[0]}`)
    await shot(`fail-${name.replace(/\W+/g, '-').slice(0, 40)}`).catch(() => undefined)
  }
}

async function shot(name) {
  shotN += 1
  await page.screenshot({ path: join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`), fullPage: true })
}

async function until(fn, { timeoutMs = 120_000, everyMs = 1000, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e.message
    }
    await sleep(everyMs)
  }
  throw new Error(`timed out waiting for ${what} (last: ${typeof last === 'string' ? last : JSON.stringify(last)?.slice(0, 200)})`)
}

/** The CP's truth, read the way the agent reads it: with the App key. */
async function cpApi(path, init = {}) {
  const res = await fetch(`${CP}/v1/apps/${APP}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${KEY}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // markdown or bytes
  }
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${text.slice(0, 200)}`)
  return body
}

async function admin(method, path, body) {
  const res = await fetch(`${CP}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.text() }
}

function cli(args) {
  return spawnSync('node', [CLI, ...args], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 10 * 60_000,
    env: { ...process.env, BOXLITE_API_URL: CP, BOXLITE_API_KEY: KEY },
  })
}

const text = (locator) => locator.innerText({ timeout: 5000 })
const tab = async (name) => {
  await page.getByRole('tab', { name, exact: true }).first().click()
  await page.waitForTimeout(600)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  console.log(`Console e2e · CP ${CP} · console ${CONSOLE} · app ${APP}`)
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  // "Copy prompt" is how the user takes the working key; the test reads what it put on the clipboard.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(CONSOLE).origin })
  page = await context.newPage()
  const consoleErrors = []
  page.on('pageerror', (e) => consoleErrors.push(e.message))
  await admin('PUT', '/admin/secrets/org/e2e-secret', { value: 's3cr3t-value' })

  try {
    await step('login with the admin token', async () => {
      await page.goto(`${CONSOLE}/console/login`)
      await shot('login')
      // With GitHub sign-in set up, the operator's token form sits behind its disclosure.
      if (!(await page.locator('input[name=token]').isVisible())) await page.getByText(/Platform operator/).click()
      await page.fill('input[name=token]', ADMIN)
      await page.click('button[type=submit]')
      await page.waitForURL(/\/console\/dashboard\/apps/)
      await page.getByRole('heading', { name: 'Apps' }).waitFor()
    })

    await step('create the app; the page masks the key and Copy prompt hands over the working one', async () => {
      await page.getByRole('button', { name: 'New App' }).first().click()
      await page.keyboard.type(APP)
      await page.getByRole('button', { name: 'Create app' }).click()
      await page.getByText('Hand off to your agent', { exact: false }).first().waitFor()
      const shown = await text(page.locator('pre').first())
      assert(!/bxl_app_[a-z2-7]{32}/.test(shown), 'the page shows the full App key')
      await shot('created-prompt')
      await page.getByRole('button', { name: 'Copy prompt' }).click()
      const prompt = await page.evaluate(() => navigator.clipboard.readText())
      KEY = /bxl_app_[a-z2-7]{32}/.exec(prompt)?.[0] ?? ''
      assert(KEY, `no App key in the copied prompt: ${prompt.slice(0, 200)}`)
      assert(prompt.includes(`${CP}/agent.md`), 'prompt does not point at agent.md')
      assert((await cpApi('')).name === APP, 'CP does not know the app')
      return `key …${KEY.slice(-4)}`
    })

    let deploy
    await step('the agent deploys with the real CLI (init, then deploy in the background)', async () => {
      DIR = mkdtempSync(join(tmpdir(), 'console-e2e-'))
      cpSync(join(ROOT, 'e2e/fixtures/kitchen-sink'), DIR, { recursive: true })
      writeFileSync(join(DIR, 'boxlite.toml'), readFileSync(join(DIR, 'boxlite.toml'), 'utf8').replace('name = "e2e"', `name = "${APP}"`))
      const init = cli(['init'])
      assert(init.status === 0, `init exit ${init.status}: ${init.stderr || init.stdout}`)
      deploy = new Promise((resolve) => {
        const child = spawn('node', [CLI, 'deploy', '-m', 'first version'], { cwd: DIR, env: { ...process.env, BOXLITE_API_URL: CP, BOXLITE_API_KEY: KEY } })
        let out = ''
        child.stdout.on('data', (d) => (out += d))
        child.stderr.on('data', (d) => (out += d))
        child.on('close', (code) => resolve({ code, out }))
      })
    })

    await step('the header follows the deploy live: Deploying #1 · <step> · <elapsed>', async () => {
      const progress = page.getByTestId('deploy-progress').first()
      const seen = new Set()
      const line = await until(async () => {
        const t = (await progress.isVisible()) ? await text(progress) : ''
        const m = /Deploying #1 · (\w+) · (\d+[:.]\d+)/.exec(t)
        if (m) seen.add(m[1])
        return m ? t : null
      }, { timeoutMs: 90_000, everyMs: 500, what: 'the header progress line' })
      await shot('header-deploying')
      await tab('Deployments')
      const row = page.getByTestId('deployment-row-1')
      await until(async () => /Deploying|Queued/i.test(await text(row)) || null, { timeoutMs: 60_000, everyMs: 500, what: 'the running row' })
      await shot('deployments-row-deploying')
      return line
    })

    await step('the first deployment goes live and the header says Running', async () => {
      const r = await deploy
      assert(r.code === 0, `deploy exit ${r.code}: ${r.out.slice(-400)}`)
      // The header states only the app's state; which deployment is live is the Deployments row's job.
      await until(async () => /\bRunning\b/.test(await text(page.locator('h1').first().locator('..'))) || null, { timeoutMs: 30_000, what: 'Running' })
      await until(async () => /LIVE/.test(await text(page.getByTestId('deployment-row-1'))) || null, { timeoutMs: 15_000, what: 'row #1 live' })
      return '#1 live'
    })

    await step('in a new session, Copy instructions issues one more working key; the first keeps working', async () => {
      // A reload drops the prompt this tab was given at creation, like opening the console elsewhere.
      await page.goto(`${CONSOLE}/console/dashboard/apps/${APP}?tab=overview`)
      await page.getByText('Hand off to your agent').first().waitFor()
      assert(!/bxl_app_[a-z2-7]{32}/.test(await text(page.locator('pre').first())), 'the overview shows a full App key')
      await page.getByRole('button', { name: 'Copy instructions' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByText(`New prompt for ${APP}`).waitFor()
      await shot('issued-prompt')
      await dialog.getByRole('button', { name: 'Copy prompt' }).click()
      const issued = /bxl_app_[a-z2-7]{32}/.exec(await page.evaluate(() => navigator.clipboard.readText()))?.[0]
      assert(issued && issued !== KEY, 'Copy instructions did not hand over a new key')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      for (const key of [KEY, issued]) {
        const r = await fetch(`${CP}/v1/apps/${APP}/whoami`, { headers: { authorization: `Bearer ${key}` } })
        assert(r.status === 200, `key …${key.slice(-4)} → ${r.status}`)
      }
      return `issued …${issued.slice(-4)}; …${KEY.slice(-4)} still works`
    })

    await step('deployment detail is a full timeline matching the CP', async () => {
      await tab('Deployments')
      await page.getByTestId('deployment-row-1').click()
      await page.getByTestId('deployment-detail').waitFor()
      const truth = await cpApi('/envs/main/deployments/1/timeline')
      for (const s of truth.steps) {
        const row = await text(page.getByTestId(`step-${s.name}`))
        assert(/Done/i.test(row), `step ${s.name} not done on screen: ${row}`)
        assert(s.started_at, `CP has no start time for ${s.name}`)
      }
      const log = await text(page.getByTestId('deployment-log'))
      const someLine = truth.logs.find((l) => l.source === 'build')?.line ?? truth.logs[0].line
      assert(log.includes(someLine.slice(0, 40)), `log misses "${someLine}"`)
      const code = await text(page.getByTestId('code-changes'))
      assert(/\+\d+ added/.test(code), `no code file counts: ${code}`)
      assert(/agent …/.test(await text(page.getByTestId('deployment-detail'))), 'who triggered it is missing')
      await shot('deployment-detail')
      return `${truth.steps.length} steps, ${truth.logs.length} log lines`
    })

    await step('services and schedules (Deployments › Services) match the CP', async () => {
      // The Overview lists the services by name; their processes are under Deployments › Services.
      await tab('Deployments')
      await page.getByRole('tab', { name: /^Services/ }).click()
      const services = await cpApi('/envs/main/services')
      for (const s of services) {
        // The process details (pid, port, restarts) are in the row's expanded part.
        const head = page.getByTestId(`service-${s.name}`).getByRole('button').first()
        if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
        const row = await text(page.getByTestId(`service-${s.name}`))
        assert(/RUNNING/i.test(row) === (s.state === 'running'), `service ${s.name}: screen "${row}" vs CP ${s.state}`)
        if (s.pid) assert(row.includes(String(s.pid)), `pid ${s.pid} missing`)
      }
      const schedules = await cpApi('/envs/main/schedules')
      // The table says the schedule in words; the raw cron is on hover.
      for (const s of schedules) await page.locator(`[title="${s.cron}"]`).first().waitFor()
      await page.getByText('every minute').first().waitFor()
      await shot('services')
      return `${services.length} service(s), ${schedules.length} schedule(s)`
    })

    await step('logs show the CP lines, filterable by deployment', async () => {
      await tab('Logs')
      const lines = await cpApi('/envs/main/logs?limit=50&source=system')
      const probe = lines.at(-1).line
      // system lines are platform detail: out of the default stream, picked from the Platform menu.
      await page.getByRole('button', { name: /^Platform/ }).click()
      await page.getByRole('menuitem', { name: /system/ }).click()
      await page.keyboard.press('Escape')
      await page.getByText(probe.slice(0, 50), { exact: false }).first().waitFor({ timeout: 15_000 })
      // A deployment's lines are reached from its timeline.
      await tab('Deployments')
      await page.getByTestId('deployment-row-1').click()
      await page.getByRole('button', { name: 'View in Logs' }).click()
      await page.waitForURL(/deployment=1/)
      await page.getByRole('button', { name: /Deployment #1/ }).waitFor()
      await shot('logs-deployment-1')
      return `found "${probe.slice(0, 40)}…"`
    })

    await step('activity says who, what, when, and links to the deployment', async () => {
      await page.getByRole('tab', { name: /Activity/ }).click()
      const rows = page.getByTestId('activity-row')
      await rows.first().waitFor()
      const all = (await rows.allInnerTexts()).join('\n')
      assert(all.includes(`key …${KEY.slice(-4)}`), 'agent key actor missing')
      assert(all.includes('console') && all.includes('created the app'), 'console actor for create missing')
      await page.getByRole('button', { name: '#1 →' }).first().click()
      await page.getByTestId('deployment-detail').waitFor()
      await page.goBack()
      await shot('activity')
    })

    await step('auth tab matches the CP: providers, redirect URI, Google explained', async () => {
      await tab('Auth')
      const truth = await cpApi('/envs/main/auth')
      const gh = await text(page.getByTestId('method-github'))
      assert(/ready/i.test(gh) === (truth.providers.find((p) => p.name === 'github')?.status === 'ready'), `github: ${gh}`)
      await page.getByTestId('method-github').getByRole('button').last().click()
      await page.getByRole('menuitem', { name: 'Copy redirect URI' }).click()
      const uri = await page.evaluate(() => navigator.clipboard.readText())
      assert(/\/auth\/callback\/github/.test(uri), `redirect URI copied: ${uri}`)
      assert(/your own Google OAuth app/i.test(await text(page.getByTestId('method-google'))), 'Google not explained')
      await shot('auth')
    })

    await step('database tables and row counts match the CP', async () => {
      await tab('Database')
      const schema = await cpApi('/envs/main/db/schema')
      const count = await cpApi('/envs/main/db/sql', { method: 'POST', body: JSON.stringify({ query: 'select count(*) from ticks' }) })
      await page.getByText('ticks', { exact: true }).first().waitFor({ timeout: 60_000 })
      for (const t of schema.tables) await page.getByText(t.name, { exact: true }).first().waitFor()
      await shot('database-tables')
      return `${schema.tables.length} tables, ticks=${count.rows[0][0]}`
    })

    await step('SQL: DDL on main is refused with the migration hint; a write names its statement', async () => {
      await page.getByRole('tab', { name: 'SQL console' }).click()
      await page.fill('textarea', 'create table nope (id int)')
      await page.keyboard.press('ControlOrMeta+Enter')
      const err = await text(page.getByTestId('sql-error'))
      assert(/migrations\/0002_change\.sql/.test(err) && /Ask your agent/.test(err) && !/boxlite-app/.test(err), `no migration hint in words: ${err}`)
      await shot('sql-ddl-refused')
      await page.fill('textarea', "insert into items (title) values ('from the console')")
      await page.keyboard.press('ControlOrMeta+Enter')
      await page.getByRole('heading', { name: /Run INSERT on main\?/ }).waitFor()
      await page.getByRole('button', { name: 'Run INSERT' }).click()
      await until(async () => /1 row affected/.test(await text(page.getByTestId('sql-affected'))) || null, { timeoutMs: 30_000, what: '1 row affected' })
      const rows = await cpApi('/envs/main/db/sql', { method: 'POST', body: JSON.stringify({ query: "select count(*) from items where title = 'from the console'" }) })
      assert(Number(rows.rows[0][0]) === 1, 'the insert did not land')
    })

    await step('backups explain the 6-hour restore window', async () => {
      await page.getByRole('tab', { name: /Backups/ }).click()
      assert(/6 hours/.test(await text(page.getByTestId('restore-window'))), 'no 6-hour explanation')
    })

    await step('volumes list the CP volumes and their files', async () => {
      await tab('Volumes')
      const vols = await cpApi('/envs/main/volumes')
      await shot('volumes')
      // Each volume's files open in a side panel from its "Browse files" button.
      const summaries = []
      for (const [i, v] of vols.entries()) {
        await page.getByRole('button', { name: 'Browse files' }).nth(i).click()
        const sheet = page.getByTestId(`volume-files-${v.name}`)
        await sheet.waitFor()
        await page.waitForTimeout(1500)
        if (i === 0) await shot('volume-files')
        summaries.push((await text(sheet)).split('\n').slice(0, 2).join(' · '))
        await page.keyboard.press('Escape')
        await sheet.waitFor({ state: 'detached' })
      }
      return summaries.join(' | ')
    })

    await step('variables show live values; editing one starts a deployment that goes live', async () => {
      await tab('Variables')
      const vars = await cpApi('/envs/main/vars')
      const greeting = vars.find((v) => v.name === 'GREETING')
      await page.getByText(greeting.value, { exact: true }).first().waitFor()
      await page.getByRole('button', { name: 'Edit' }).first().click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type('hello from the console')
      await page.getByRole('button', { name: 'Save and deploy' }).click()
      await page.getByTestId('deploy-progress').first().waitFor({ timeout: 15_000 })
      await shot('variables-deploying')
      await until(async () => (await cpApi('/envs/main/deployments?limit=1'))[0].status === 'live' || null, { timeoutMs: 180_000, what: 'variable deployment live' })
      const d = (await cpApi('/envs/main/deployments?limit=1'))[0]
      assert(d.message === 'Set GREETING', `latest deployment is "${d.message}"`)
      const after = (await cpApi('/envs/main/vars')).find((v) => v.name === 'GREETING')
      assert(after.value === 'hello from the console', `CP has ${after.value}`)
      return `#${d.number} live`
    })

    await step('rollback to #1 is a new deployment that goes live', async () => {
      await tab('Deployments')
      await page.getByTestId('deployment-row-1').getByRole('button', { name: 'Roll back' }).click()
      await page.getByRole('button', { name: 'Roll back to #1' }).click()
      await until(async () => {
        const d = (await cpApi('/envs/main/deployments?limit=1'))[0]
        return d.kind === 'rollback' && d.status === 'live' ? d : null
      }, { timeoutMs: 180_000, what: 'rollback live' })
      await page.waitForTimeout(2000)
      await shot('deployments-after-rollback')
    })

    await step('access: public asks first, then the CP has public; back to private', async () => {
      await page.getByRole('button', { name: /Access:/ }).click()
      await page.getByRole('menuitem', { name: /Public/ }).click()
      await page.getByRole('button', { name: 'Make public' }).click()
      await until(async () => (await cpApi('/envs/main/access')).access === 'public' || null, { timeoutMs: 15_000, what: 'access public' })
      await page.getByRole('button', { name: /Access:/ }).click()
      await shot('access-menu')
      await page.getByRole('menuitem', { name: /Private/ }).click()
      await until(async () => (await cpApi('/envs/main/access')).access === 'private' || null, { timeoutMs: 15_000, what: 'access private' })
    })

    await step('sleep stops the Box; Open app wakes it and serves the app', async () => {
      await page.getByRole('button', { name: 'More' }).first().click()
      await page.getByRole('menuitem', { name: 'Sleep now' }).click()
      await until(async () => /Sleeping/.test(await text(page.locator('h1').first().locator('..'))) || null, { timeoutMs: 30_000, what: 'Sleeping' })
      await shot('sleeping')
      const [tabPage] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: /Open app/ }).first().click()])
      await until(async () => {
        const body = await tabPage.locator('body').innerText().catch(() => '')
        return !/Starting|about:blank/.test(body) && body.trim().length > 0 && !/not found|nothing deployed/i.test(body) ? body : null
      }, { timeoutMs: 120_000, everyMs: 2000, what: 'the app to wake' })
      await tabPage.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-opened-app.png`) })
      await tabPage.close()
      await until(async () => !/Sleeping/.test(await text(page.locator('h1').first().locator('..'))) || null, { timeoutMs: 60_000, what: 'awake' })
    })

    await step('delete is soft: the app moves to Recently deleted and can be restored', async () => {
      await page.getByRole('button', { name: 'More' }).first().click()
      await page.getByRole('menuitem', { name: 'Delete app' }).click()
      // Restorable for 7 days, so it asks once (no typing the name).
      await page.getByRole('button', { name: 'Delete app' }).click()
      await page.waitForURL(/\/dashboard\/apps$/)
      const section = page.getByRole('region', { name: 'Recently deleted' })
      await section.getByText(APP, { exact: true }).waitFor({ timeout: 15_000 })
      const gone = await fetch(`${CP}/v1/apps/${APP}`, { headers: { authorization: `Bearer ${KEY}` } })
      assert(gone.status === 401 || gone.status === 404, `deleted app key still works: ${gone.status}`)
      await shot('recently-deleted')
      await section.getByRole('button', { name: `Restore ${APP}` }).click()
      await page.getByRole('link', { name: `Open ${APP}` }).waitFor({ timeout: 15_000 })
      assert((await cpApi('')).name === APP, 'restored app key does not work')
    })

    await step('delete again', async () => {
      await page.getByRole('link', { name: `Open ${APP}` }).getByRole('button', { name: 'More' }).click()
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      await page.getByRole('button', { name: 'Delete' }).click()
      await page.getByRole('region', { name: 'Recently deleted' }).getByText(APP, { exact: true }).waitFor({ timeout: 15_000 })
    })

    await step('no uncaught errors in the page', async () => {
      assert(consoleErrors.length === 0, consoleErrors.join(' | '))
    })
  } finally {
    await browser.close()
    if (process.env.KEEP !== '1') {
      const purge = await admin('DELETE', `/v1/apps/${APP}?purge=1`)
      console.log(`  purge ${APP}: ${purge.status} ${purge.body.slice(0, 120)}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${SHOTS}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
