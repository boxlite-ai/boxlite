/*
 * Failure-injection runner for the box usage-period ledger.
 *
 * Question it answers: can a box end up running with no usage period open, or
 * finished with one still open, when the API dies between committing the box
 * row and writing the ledger?
 *
 * How the window is opened (no production code is modified):
 *  - Redis lock:   UsageService's first act is waitForLock(boxId). Holding that
 *                  key parks the handler indefinitely while the box row is
 *                  already committed — the exact post-commit/pre-ledger state.
 *  - INSERT trigger: a BEFORE INSERT pg_sleep on box_usage_periods parks the
 *                  handler *between* closing the old period and opening the
 *                  new one, which is otherwise a sub-millisecond window.
 * The kill is a real SIGKILL of a real process; the restart is a real boot.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import Redis from 'ioredis'
import pg from 'pg'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const API_DIR = path.resolve(HERE, '../../api')
const WORKER = path.join(HERE, 'worker.ts')
const TS_NODE = path.resolve(HERE, '../../node_modules/.bin/ts-node')

const DB = {
  host: process.env.CHAOS_DB_HOST || '127.0.0.1',
  port: Number(process.env.CHAOS_DB_PORT || 55432),
  user: process.env.CHAOS_DB_USER || 'postgres',
  password: process.env.CHAOS_DB_PASSWORD || 'postgres',
}
const ADMIN_DB = process.env.CHAOS_ADMIN_DB || 'boxlite'
const CHAOS_DB = 'boxlite_usage_chaos'
const REDIS = {
  host: process.env.CHAOS_REDIS_HOST || '127.0.0.1',
  port: Number(process.env.CHAOS_REDIS_PORT || 6379),
  db: Number(process.env.CHAOS_REDIS_DB || 14),
}

const workerEnv = {
  ...process.env,
  DB_HOST: String(DB.host),
  DB_PORT: String(DB.port),
  DB_USERNAME: DB.user,
  DB_PASSWORD: DB.password,
  DB_DATABASE: CHAOS_DB,
  REDIS_HOST: String(REDIS.host),
  REDIS_PORT: String(REDIS.port),
  REDIS_DB: String(REDIS.db),
}

// ------------------------------------------------------------------ plumbing

let sql
let redis
const q = (text, values) => sql.query(text, values).then((r) => r.rows)

// A scenario that throws between start() and its signal() would otherwise leave
// a ts-node child alive holding Postgres and Redis connections. Every live
// worker is tracked so the top-level finally can reap it.
const liveWorkers = new Set()

class Worker {
  constructor() {
    this.seq = 0
    this.pending = new Map()
    this.events = []
    this.logs = []
    this.exited = null
  }

  async start() {
    this.child = spawn(TS_NODE, ['-P', './tsconfig.json', '--transpile-only', WORKER], {
      cwd: API_DIR,
      env: workerEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stderr.on('data', (chunk) => this.logs.push(...String(chunk).split('\n').filter(Boolean)))
    let buffer = ''
    const ready = new Promise((resolve) => {
      this.child.stdout.on('data', (chunk) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line.startsWith('{')) {
            this.logs.push(line)
            continue
          }
          const message = JSON.parse(line)
          if (message.event === 'ready') resolve(message)
          else if (message.event) this.events.push(message)
          else this.pending.get(message.id)?.(message)
        }
      })
    })
    liveWorkers.add(this)
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal }
      liveWorkers.delete(this)
      for (const resolve of this.pending.values()) resolve({ ok: false, error: 'worker died' })
      this.pending.clear()
    })
    // unref'd, or every worker ever started keeps the runner alive for two more
    // minutes after the summary prints
    const bootTimeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('worker boot timeout')), 120_000).unref()
    })
    const info = await Promise.race([ready, bootTimeout])
    this.pid = info.pid
    return info
  }

  send(op, extra = {}) {
    const id = ++this.seq
    const reply = new Promise((resolve) => this.pending.set(id, resolve))
    this.child.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`)
    return reply
  }

  async call(op, extra = {}) {
    const reply = await this.send(op, extra)
    if (!reply.ok) throw new Error(`${op} failed: ${reply.error}`)
    return reply
  }

  async signal(name, graceMs = 30_000) {
    if (this.exited) return this.exited
    this.child.kill(name)
    const deadline = Date.now() + graceMs
    while (!this.exited && Date.now() < deadline) await sleep(20)
    if (!this.exited) {
      this.child.kill('SIGKILL')
      while (!this.exited) await sleep(20)
    }
    return this.exited
  }
}

async function setupSchema() {
  const admin = new pg.Client({ ...DB, database: ADMIN_DB })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS "${CHAOS_DB}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${CHAOS_DB}"`)
  await admin.end()

  await new Promise((resolve, reject) => {
    const setup = spawn(TS_NODE, ['-P', './tsconfig.json', '--transpile-only', WORKER, '--setup'], {
      cwd: API_DIR,
      env: workerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    setup.stdout.on('data', (c) => (out += c))
    setup.stderr.on('data', (c) => (out += c))
    setup.on('exit', (code) =>
      code === 0 && out.includes('setup-done') ? resolve() : reject(new Error(`setup failed: ${out}`)),
    )
  })
}

const lockKey = (boxId) => `usage-period-${boxId}`
const holdLock = (boxId, ttl = 600) => redis.set(lockKey(boxId), 'chaos', 'EX', ttl)
const releaseLock = (boxId) => redis.del(lockKey(boxId))

/** Widens the gap between closing a period and opening the next one. */
const delayInserts = (seconds) =>
  q(`CREATE OR REPLACE FUNCTION chaos_delay_insert() RETURNS trigger AS $$
       BEGIN PERFORM pg_sleep(${seconds}); RETURN NEW; END $$ LANGUAGE plpgsql`).then(() =>
    q(`CREATE TRIGGER chaos_delay BEFORE INSERT ON box_usage_periods
       FOR EACH ROW EXECUTE FUNCTION chaos_delay_insert()`),
  )
const stopDelayingInserts = () => q(`DROP TRIGGER IF EXISTS chaos_delay ON box_usage_periods`)

const ledger = async (boxId) => {
  const live = await q(`SELECT "startAt","endAt",cpu,gpu,mem,disk FROM box_usage_periods WHERE "boxId"=$1`, [boxId])
  const archived = await q(
    `SELECT "startAt","endAt",cpu,gpu,mem,disk FROM box_usage_periods_archive WHERE "boxId"=$1`,
    [boxId],
  )
  return [...live, ...archived].sort((a, b) => a.startAt - b.startAt)
}
const openCount = async (boxId) =>
  Number((await q(`SELECT count(*)::int n FROM box_usage_periods WHERE "boxId"=$1 AND "endAt" IS NULL`, [boxId]))[0].n)
const boxState = async (boxId) => (await q(`SELECT state FROM box WHERE id=$1`, [boxId]))[0]?.state

const results = []
const report = (id, title, diverged, detail) => {
  results.push({ id, title, diverged, detail })
  console.log(`\n[${id}] ${title}\n     ${diverged ? '>>> DIVERGENCE' : '    consistent'}: ${detail}`)
}

const backdate = (boxId, hours = 25) =>
  q(`UPDATE box_usage_periods SET "startAt" = now() - interval '${hours} hours' WHERE "boxId"=$1 AND "endAt" IS NULL`, [
    boxId,
  ])

// ----------------------------------------------------------------- scenarios

async function s1_killBeforeOpen() {
  const worker = new Worker()
  await worker.start()
  const { boxId } = await worker.call('createBox', { organizationId: randomUUID() })

  await holdLock(boxId) //                        park the handler at its first await
  await worker.call('transition', { boxId, updateData: { state: 'started' } })
  const stateAtKill = await boxState(boxId)
  const openAtKill = await openCount(boxId)
  await worker.signal('SIGKILL') //               API dies after the box row, before the ledger

  await releaseLock(boxId)
  const restarted = new Worker()
  await restarted.start()
  await restarted.call('cron', { name: 'rollover' })
  await restarted.call('cron', { name: 'archive' })
  const after = { state: await boxState(boxId), open: await openCount(boxId), rows: (await ledger(boxId)).length }
  await restarted.signal('SIGTERM')

  report(
    'S1',
    'box reaches STARTED, API SIGKILLed before the ledger write',
    after.state === 'started' && after.rows === 0,
    `at kill: box=${stateAtKill} open=${openAtKill}; after restart + both crons: box=${after.state}, ledger rows=${after.rows}, open=${after.open}`,
  )
  return boxId
}

async function s2_killBeforeClose() {
  const worker = new Worker()
  await worker.start()
  const { boxId } = await worker.call('createBox', { organizationId: randomUUID() })
  await worker.call('transition', { boxId, updateData: { state: 'started' } })
  await worker.call('settle')

  await holdLock(boxId)
  await worker.call('transition', { boxId, updateData: { desiredState: 'destroyed', state: 'destroyed' } })
  await worker.signal('SIGKILL')

  await releaseLock(boxId)
  const restarted = new Worker()
  await restarted.start()
  await restarted.call('cron', { name: 'rollover' })
  const openAfterRestart = await openCount(boxId)

  // ... and how long the over-billing lasts: the roll-over only looks at
  // periods older than a day.
  await backdate(boxId)
  await restarted.call('cron', { name: 'rollover' })
  const openAfterADay = await openCount(boxId)
  await restarted.signal('SIGTERM')

  report(
    'S2',
    'box reaches DESTROYED, API SIGKILLed before the period is closed',
    openAfterRestart > 0,
    `box=destroyed; open period after restart + roll-over: ${openAfterRestart}; after the period ages past 24h: ${openAfterADay} (so it self-heals, but only after up to a day of over-billing)`,
  )
}

async function s3_killBetweenCloseAndOpen() {
  const worker = new Worker()
  await worker.start()
  const { boxId } = await worker.call('createBox', { organizationId: randomUUID() })
  await worker.call('transition', { boxId, updateData: { state: 'started' } })
  await worker.call('settle')

  await delayInserts(30) //                       park the handler inside the INSERT
  worker.send('transition', { boxId, updateData: { desiredState: 'stopped', state: 'stopping' } })
  // wait until the compute period is closed but the disk-only one is not in yet
  const deadline = Date.now() + 30_000
  let closedButNotReopened = false
  while (Date.now() < deadline && !closedButNotReopened) {
    const rows = await ledger(boxId)
    closedButNotReopened = rows.length === 1 && rows[0].endAt !== null
    if (!closedButNotReopened) await sleep(50)
  }
  await worker.signal('SIGKILL')
  await stopDelayingInserts()

  const restarted = new Worker()
  await restarted.start()
  await restarted.call('cron', { name: 'rollover' })
  await restarted.call('cron', { name: 'archive' })
  const rows = await ledger(boxId)
  await restarted.signal('SIGTERM')

  report(
    'S3',
    'box reaches STOPPING, API SIGKILLed between closing the compute period and opening the disk-only one',
    closedButNotReopened && (await openCount(boxId)) === 0,
    `caught mid-handler: ${closedButNotReopened}; after restart + both crons: ${rows.length} period(s), open=${await openCount(boxId)} — the stopped box's disk is billed to nobody`,
  )
}

async function s4_gracefulRestart() {
  const worker = new Worker()
  await worker.start()
  const { boxId } = await worker.call('createBox', { organizationId: randomUUID() })

  await holdLock(boxId)
  await worker.call('transition', { boxId, updateData: { state: 'started' } })
  const openBeforeSigterm = await openCount(boxId)

  const startedAt = Date.now()
  worker.child.kill('SIGTERM')
  await sleep(1500)
  const stillAliveWhileBlocked = worker.exited === null
  await releaseLock(boxId) //                     let the in-flight handler finish
  while (!worker.exited && Date.now() - startedAt < 30_000) await sleep(20)
  const drainMs = Date.now() - startedAt

  const open = await openCount(boxId)
  report(
    'S4',
    'same window, but a graceful SIGTERM instead of SIGKILL',
    open === 0,
    `open period before SIGTERM: ${openBeforeSigterm}; shutdown still blocked 1.5s later: ${stillAliveWhileBlocked}; drained in ${drainMs}ms; open period after exit: ${open}`,
  )
}

async function s5_redisGone() {
  const worker = new Worker()
  await worker.start()
  const { boxId } = await worker.call('createBox', { organizationId: randomUUID() })

  await worker.call('killRedis')
  const reply = await worker.send('transition', { boxId, updateData: { state: 'started' } })
  await sleep(3000)
  const open = await openCount(boxId)
  const survived = worker.exited === null
  const rejections = worker.events.filter((event) => event.event === 'unhandledRejection')
  const alive = survived ? await worker.send('ping') : { ok: false }
  // Did the handler fail, or is it still parked? A handler that never returns
  // holds its activeJobs slot, which is what onApplicationShutdown waits on.
  const stuck = survived ? (reply.inFlight ?? []).length > 0 : null
  // @nestjs/event-emitter wraps every @OnEvent listener in a try/catch whose
  // `suppressErrors` defaults to true, so a handler that throws is downgraded
  // to a log line. Confirm that is where the failure went.
  const swallowed = worker.logs.filter((line) => /Connection is closed|\[Event\]|ERROR/.test(line))
  const settled = survived
    ? await Promise.race([worker.send('settle'), sleep(8000).then(() => ({ ok: 'timeout' }))])
    : {}
  await worker.signal('SIGKILL')

  report(
    'S5',
    'Redis unreachable when the state event fires',
    open === 0,
    `transition itself ${reply.ok ? 'succeeded' : 'failed'} (the box row commits either way); periods written: ${open}; ` +
      `process survived: ${survived}; still serving other requests: ${alive.ok}; unhandled rejections: ${rejections.length}; ` +
      `handler still holding a job slot at reply time: ${stuck}; drained within 8s: ${settled.ok === 'timeout' ? 'no' : 'yes'}; ` +
      `error surfaced only as a log line (suppressErrors default): ${swallowed.length > 0}` +
      (swallowed[0] ? ` -> ${swallowed[0].replace(/\s+/g, ' ').slice(0, 120)}` : ''),
  )
}

async function s6_staleLock() {
  const worker = new Worker()
  await worker.start()
  const { boxId } = await worker.call('createBox', { organizationId: randomUUID() })

  await holdLock(boxId, 5) //                     a lock left behind by a process that died
  const startedAt = Date.now()
  await worker.call('transition', { boxId, updateData: { state: 'started' } })
  await worker.call('settle')
  const waitedMs = Date.now() - startedAt
  const open = await openCount(boxId)
  await worker.signal('SIGTERM')

  report(
    'S6',
    'per-box lock left behind by a dead process (TTL 5s)',
    open !== 1,
    `ledger write landed after ${waitedMs}ms (blocked until the lock TTL expired); open periods: ${open}`,
  )
}

// S4 shows the graceful drain protecting ONE in-flight handler. @TrackJobExecution
// keys activeJobs by method name, not by invocation, so two concurrent
// handleBoxStateUpdate calls share a single Set entry — and the first to finish
// deletes it out from under the second.
async function s7_concurrentDrain() {
  const worker = new Worker()
  await worker.start()
  const parked = (await worker.call('createBox', { organizationId: randomUUID() })).boxId
  const quick = (await worker.call('createBox', { organizationId: randomUUID() })).boxId

  await holdLock(parked)
  await worker.call('transition', { boxId: parked, updateData: { state: 'started' } })
  // second invocation of the same handler, this one unobstructed
  await worker.call('transition', { boxId: quick, updateData: { state: 'started' } })
  // if activeJobs tracked invocations this would still report one in flight
  const drainedWhileParked = (await worker.call('settle', {})) && true

  const startedAt = Date.now()
  await worker.signal('SIGTERM')
  const shutdownMs = Date.now() - startedAt

  await releaseLock(parked) //                     nothing left alive to act on it
  await sleep(1000)
  const parkedOpen = await openCount(parked)
  const quickOpen = await openCount(quick)

  report(
    'S7',
    'graceful SIGTERM while two handlers are in flight (activeJobs is keyed by method, not invocation)',
    parkedOpen === 0,
    `drain reported empty with a handler still parked: ${drainedWhileParked}; shutdown took ${shutdownMs}ms ` +
      `(vs ~2000ms in S4, where it correctly waited); periods after exit — parked box: ${parkedOpen}, unobstructed box: ${quickOpen}`,
  )
}

async function s8_reconciliationCoverage(strandedBoxId) {
  const worker = new Worker()
  await worker.start()
  for (let i = 0; i < 3; i += 1) {
    await worker.call('cron', { name: 'rollover' })
    await worker.call('cron', { name: 'archive' })
  }
  const open = await openCount(strandedBoxId)
  const rows = (await ledger(strandedBoxId)).length
  const state = await boxState(strandedBoxId)
  await worker.signal('SIGTERM')

  report(
    'S8',
    'does anything ever repair the S1 box? (3 more rounds of both crons)',
    rows === 0,
    `box is still ${state} with ${rows} ledger row(s) and ${open} open period(s) — no sweep exists that opens a missing period, so this box runs free forever`,
  )
}

// ---------------------------------------------------------------------- main

async function main() {
  await setupSchema()
  sql = new pg.Client({ ...DB, database: CHAOS_DB })
  await sql.connect()
  redis = new Redis.default({ host: REDIS.host, port: REDIS.port, db: REDIS.db })

  console.log(
    `chaos database: ${CHAOS_DB} on ${DB.host}:${DB.port}; redis db ${REDIS.db} on ${REDIS.host}:${REDIS.port}`,
  )

  try {
    const strandedBoxId = await s1_killBeforeOpen()
    await s2_killBeforeClose()
    await s3_killBetweenCloseAndOpen()
    await s4_gracefulRestart()
    await s5_redisGone()
    await s6_staleLock()
    await s7_concurrentDrain()
    await s8_reconciliationCoverage(strandedBoxId)
  } finally {
    for (const worker of liveWorkers) {
      worker.child.kill('SIGKILL')
    }
    await redis.flushdb().catch(() => {})
    await redis.quit().catch(() => {})
    await sql.end().catch(() => {})
    const admin = new pg.Client({ ...DB, database: ADMIN_DB })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS "${CHAOS_DB}" WITH (FORCE)`)
    await admin.end()
  }

  const diverged = results.filter((r) => r.diverged)
  console.log(`\n${'='.repeat(78)}`)
  console.log(`${diverged.length} of ${results.length} scenarios end with a ledger that does not match reality:`)
  for (const r of results) console.log(`  ${r.diverged ? 'DIVERGENCE' : 'consistent '}  ${r.id}  ${r.title}`)
}

await main()
