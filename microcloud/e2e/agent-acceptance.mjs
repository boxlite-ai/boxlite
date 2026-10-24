#!/usr/bin/env node
// Acceptance with real coding agents (the user's journey, PRD 第五节):
//   1. create an App through the console API — the same backend call as clicking New App —
//      and take the prompt exactly as the console shows it;
//   2. append one sentence and hand it to a fresh, headless Claude Code session in an empty
//      directory; nobody intervenes;
//   3. record what the agent did (time, turns, cost, tool calls, final report).
// Independent verification of the result is done afterwards (verify-acceptance.mjs).
//
//   node e2e/agent-acceptance.mjs <case-id>...      cases: m1 m2 m3 m4 m5 m6 m7 m8 m9 (default; AGENT=codex runs Codex instead of Claude Code: all, in parallel)
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CP = process.env.CP_URL ?? 'https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai'
const CONSOLE = process.env.CONSOLE_URL ?? CP.replace(/^https:\/\/8080-/, 'https://8081-')
const ADMIN = readFileSync(join(ROOT, '.cp-admin-token'), 'utf8').trim()
const OUT = join(ROOT, 'e2e/acceptance')
const STAMP = Date.now().toString(36).slice(-4)

export const CASES = {
  m1: { app: `site-${STAMP}`, ask: '做一个公司官网落地页，带联系表单，提交的内容要保存下来，我能在一个后台页面看到所有提交' },
  m2: { app: `photos-${STAMP}`, ask: '做一个图片墙，可以上传照片，刷新后照片还在' },
  m3: { app: `todo-${STAMP}`, ask: '做一个带 GitHub 登录的待办应用，每个人只看到自己的待办' },
  m4: { app: `weekly-${STAMP}`, ask: '做一个团队周报工具：大家用 GitHub 登录写周报，可以附上文件；每周一早上 9 点自动把上周所有人的周报汇总成一页给我看。先给我一个测试版看看，没问题再上正式版' },
  m5: { app: `ledger-${STAMP}`, ask: '用 Python 做一个家庭记账小工具：记录每笔收支和分类，按月看汇总图表，可以导出成 Excel' },
  m6: { app: `chat-${STAMP}`, ask: '做一个实时聊天室，打开链接的人起个昵称就能进来聊天，大家同时在线能马上看到别人发的消息，刷新后还能看到之前的聊天记录' },
  m7: { app: `club-${STAMP}`, ask: '做一个读书会报名网站：成员用邮箱验证码登录（我们很多人没有 GitHub），登录后能报名下一期读书会、看到自己报过哪些期。发验证码用我们的邮箱账号：SMTP 服务器 127.0.0.1，端口 2525，用户名 club，密码 club-mail-2026，发件人 读书会 <no-reply@club.test>。做好后直接上线，所有人都能打开' },
  m8: { app: `shop-${STAMP}`, ask: '做一个卖手工蜡烛的小网店：顾客浏览商品、加购物车、填地址下单（先不接支付，下单后显示订单号）；我自己有一个后台，能上下架商品、改价格、看所有订单和改订单状态，别人进不去后台。顾客不用登录也能买，直接上线' },
  // Coming back later: a fresh agent on another machine changes the shop Codex built (m8).
  m9: { app: process.env.M9_APP ?? 'shop-qhkb', existing: true, ask: '顾客反馈购物车里不能改数量，只能删掉重来，帮我加上数量加减；另外后台的订单列表要最新的排在最前面，还要能按订单状态筛选。别的都别动' },
}

async function consoleSession() {
  const r = await fetch(`${CONSOLE}/console/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: ADMIN, next: '/console/' }) })
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`console login failed: ${r.status}`)
  return cookie
}

async function createApp(cookie, name) {
  const r = await fetch(`${CONSOLE}/console/api/apps`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-boxlite-console': '1', origin: CONSOLE }, body: JSON.stringify({ name }) })
  const b = await r.json()
  if (r.status !== 201) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(b).slice(0, 300)}`)
  return b
}

async function issueKey(cookie, name) {
  const r = await fetch(`${CONSOLE}/console/api/apps/${name}/key/issue`, { method: 'POST', headers: { cookie, 'x-boxlite-console': '1', origin: CONSOLE } })
  const b = await r.json()
  if (r.status !== 200) throw new Error(`issue a key for ${name}: ${r.status} ${JSON.stringify(b).slice(0, 300)}`)
  return b
}

/** The same journey with Codex (AGENT=codex): `codex exec` reads stdin unless it is closed. */
function runCodex(id, prompt, dir) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const last = join(OUT, `${id}.last.txt`)
    const child = spawn('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', dir, '--json', '-o', last, prompt], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    child.stdout.on('data', (d) => chunks.push(d))
    const timer = setTimeout(() => child.kill('SIGTERM'), 45 * 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(join(OUT, `${id}.jsonl`), Buffer.concat(chunks))
      const events = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const tools = events.filter((e) => e.item?.type === 'command_execution' && e.type === 'item.completed').map((e) => String(e.item.command ?? '').slice(0, 160))
      let report = ''
      try { report = readFileSync(last, 'utf8') } catch { /* no final message */ }
      resolve({ id, exit: code, seconds: Math.round((Date.now() - t0) / 1000), turns: tools.length, cost: undefined, tools, report })
    })
  })
}

function runAgent(id, prompt, dir) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const log = join(OUT, `${id}.jsonl`)
    const child = spawn('claude', ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    child.stdout.on('data', (d) => chunks.push(d))
    const timer = setTimeout(() => child.kill('SIGTERM'), 45 * 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(log, Buffer.concat(chunks))
      const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const result = lines.find((l) => l.type === 'result') ?? {}
      const tools = lines.filter((l) => l.type === 'assistant').flatMap((l) => l.message.content.filter((c) => c.type === 'tool_use').map((c) => (c.input.command ?? c.input.file_path ?? c.name ?? '').slice(0, 160)))
      resolve({ id, exit: code, seconds: Math.round((Date.now() - t0) / 1000), turns: result.num_turns, cost: result.total_cost_usd, tools, report: result.result ?? '' })
    })
  })
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES)
mkdirSync(OUT, { recursive: true })
const cookie = await consoleSession()
const runs = await Promise.all(ids.map(async (id) => {
  const c = CASES[id]
  // An existing App: the console's "Copy prompt" on its page (a new key next to the ones in use).
  const created = c.existing ? await issueKey(cookie, c.app) : await createApp(cookie, c.app)
  // The console's prompt ends with a placeholder line for the request; replace it like a user would.
  const prompt = created.prompt.replace(/What I want:.*$/m, `What I want: ${c.ask}`)
  const dir = join(OUT, `${id}-work`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(OUT, `${id}.app.json`), JSON.stringify({ id, app: c.app, ask: c.ask, key: created.key, url: created.app?.url }, null, 2), { mode: 0o600 })
  console.log(`[${id}] ${c.app} → agent started`)
  const r = await (process.env.AGENT === 'codex' ? runCodex : runAgent)(id, prompt, dir)
  console.log(`[${id}] done in ${r.seconds}s, ${r.turns} turns, $${r.cost?.toFixed?.(2)}`)
  return { ...r, app: c.app, ask: c.ask }
}))
writeFileSync(join(OUT, 'runs.json'), JSON.stringify(runs, null, 2))
for (const r of runs) console.log(`\n===== ${r.id} · ${r.app} · ${r.seconds}s · ${r.turns} turns · $${r.cost?.toFixed?.(2)} · exit ${r.exit}\n${r.report.slice(0, 2500)}`)
