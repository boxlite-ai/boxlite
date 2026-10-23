// Exercises every platform contract the e2e checks: PORT, health, DATABASE_URL, volumes, identity
// headers, schedules, variables, secrets, logs, SIGTERM and the path prefix.
import http from 'node:http'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const UPLOADS = '/data/uploads'
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const user = (req) => req.headers['x-boxlite-user-id'] ? { id: req.headers['x-boxlite-user-id'], email: req.headers['x-boxlite-user-email'], role: req.headers['x-boxlite-user-role'] } : null
const body = async (req) => { let b = ''; for await (const c of req) b += c; return b }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (url.pathname === '/healthz') return res.end('ok')
    if (url.pathname === '/api/env') return json(res, 200, {
      app_url: process.env.BOXLITE_APP_URL, env: process.env.BOXLITE_ENV, greeting: process.env.GREETING ?? null,
      has_secret: Boolean(process.env.E2E_SECRET), app_secret_length: (process.env.E2E_APP_SECRET ?? '').length, prefix: req.headers['x-forwarded-prefix'] ?? null,
      build: existsSync('dist/build.json') ? JSON.parse(readFileSync('dist/build.json', 'utf8')) : null,
    })
    if (url.pathname === '/webhooks/ping') return json(res, 200, { received: true })
    if (url.pathname === '/api/headers') return json(res, 200, req.headers)
    if (url.pathname === '/api/me') return user(req) ? json(res, 200, user(req)) : json(res, 401, { error: 'anonymous' })
    if (url.pathname === '/api/items' && req.method === 'POST') {
      const { title } = JSON.parse(await body(req))
      const { rows } = await pool.query('insert into items(owner, title) values ($1, $2) returning id, title', [user(req)?.id ?? null, title])
      console.log(`created item ${rows[0].id}`)
      return json(res, 201, rows[0])
    }
    if (url.pathname === '/api/items') return json(res, 200, (await pool.query('select id, title from items order by id')).rows)
    if (url.pathname === '/api/files' && req.method === 'PUT') {
      mkdirSync(UPLOADS, { recursive: true })
      const name = url.searchParams.get('name').replace(/[^a-z0-9._-]/gi, '')
      writeFileSync(join(UPLOADS, name), await body(req))
      return json(res, 201, { name })
    }
    if (url.pathname === '/api/files') return json(res, 200, existsSync(UPLOADS) ? readdirSync(UPLOADS) : [])
    if (url.pathname === '/jobs/tick' && req.method === 'POST') {
      await pool.query('insert into ticks default values')
      console.log('tick')
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/api/ticks') return json(res, 200, (await pool.query('select count(*)::int as n from ticks')).rows[0])
    if (url.pathname === '/api/crash') { console.error('crash requested'); setTimeout(() => process.exit(3), 50); return json(res, 202, {}) }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (!file.includes('..') && existsSync(join('public', file))) {
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      return res.end(readFileSync(join('public', file)))
    }
    json(res, 404, { error: 'not found', path: url.pathname })
  } catch (e) {
    console.error(e.stack)
    json(res, 500, { error: e.message })
  }
})
server.listen(Number(process.env.PORT), '0.0.0.0', () => console.log(`listening on ${process.env.PORT}`))
process.on('SIGTERM', () => { console.log('SIGTERM, closing'); server.close(() => process.exit(0)) })
