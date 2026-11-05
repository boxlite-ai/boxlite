import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { AgentContext } from '@boxlite-ai/cloud-app-shared'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { API, BASE_TOML, cleanup, cli, JSON_HEADERS, KEY, linkJson, mockApi, project, tempDir } from './helpers.js'

let root: string
before(async () => {
  root = await tempDir()
})
after(async () => cleanup(root))
const NOW = new Date().toISOString()
const ORG_PATH = '/api/v1/org-1'
const ORG_API = API + ORG_PATH
const ORG_ENV = { BOXLITE_API_KEY: KEY, BOXLITE_API_URL: ORG_API }
const IDENTITY = { sub: 'user-1', path_prefix: 'org-1' }
const CLI_RELEASE = {
  version: '0.9.0',
  url: 'https://api.test/api/internal/apps/artifacts/release-1/boxlite-app.tgz',
}
const APP_INFO = { name: 'crm', envs: [{ name: 'main', status: 'live', url: 'https://cp.test/crm' }] }
const orgLink = (base_version = 1) => JSON.stringify({ app: 'crm', env: 'main', base_version, api_url: ORG_API })

function organizationIdentity(pool: ReturnType<typeof mockApi>['pool'], count = 1) {
  pool
    .intercept({ path: '/api/v1/me', method: 'GET', headers: { authorization: `Bearer ${KEY}` } })
    .reply(200, IDENTITY, { headers: JSON_HEADERS })
    .times(count)
}

function orgCliVersion(pool: ReturnType<typeof mockApi>['pool'], count = 1) {
  pool
    .intercept({ path: `${ORG_PATH}/cli/version`, method: 'GET' })
    .reply(200, CLI_RELEASE, { headers: JSON_HEADERS })
    .times(count)
}

function context(over: Partial<AgentContext> = {}): AgentContext {
  return {
    app: 'crm',
    env: 'main',
    control_plane: 'https://cp.test',
    generated_at: NOW,
    status: 'live',
    urls: { app: 'https://cp.test/crm', health: 'https://cp.test/crm/healthz', login: null },
    access: { level: 'private', source: 'manifest' },
    environments: [{ name: 'main', status: 'live', url: 'https://cp.test/crm' }],
    live: { deployment: 2, spec_version: 2, live_at: NOW },
    box: { id: 'b1', state: 'running' },
    runtime: { image: 'node', size: 'small', build: ['npm ci'] },
    services: [
      {
        name: 'web',
        exposed: true,
        command: 'node server.js',
        static: null,
        health_path: '/healthz',
        state: 'running',
        health: 'healthy',
        restarts: 0,
        last_exit_code: null,
      },
    ],
    schedules: [],
    database: {
      status: 'ready',
      branch: 'br-main',
      tables: [{ name: 'deals', columns: [{ name: 'id', type: 'integer', nullable: false, default: null }] }],
      migrations: [{ file: '0001_init.sql', status: 'applied', deployment: 2, applied_at: NOW }],
    },
    volumes: [{ name: 'uploads', mount: '/data/uploads', mode: 'rw' }],
    auth: { enabled: false, providers: [], protect: [], login_url: '', users: 0 },
    variables: [
      { name: 'LOG_LEVEL', value: 'info', secret: false, source: 'boxlite.toml', resolved: true },
      { name: 'OPENAI_API_KEY', value: null, secret: true, source: 'secret org/openai', resolved: true },
    ],
    deployments: [
      {
        number: 2,
        kind: 'deploy',
        status: 'live',
        message: 'deals',
        created_at: NOW,
        finished_at: NOW,
        spec_version: 2,
        error: null,
      },
    ],
    recent_errors: [],
    next_actions: [],
    cli: { latest_version: '0.9.0' },
    ...over,
  }
}

test('whoami reports the organization and the linked App independently', async () => {
  const dir = await project(root, { '.boxlite/link.json': orgLink() })
  const { agent, pool } = mockApi()
  organizationIdentity(pool, 2)
  orgCliVersion(pool, 2)
  pool
    .intercept({ path: `${ORG_PATH}/apps/crm`, method: 'GET' })
    .reply(200, APP_INFO, { headers: JSON_HEADERS })
    .times(2)
  const opts = { cwd: dir, dispatcher: agent, env: { BOXLITE_API_KEY: KEY } }
  const human = await cli(['whoami'], opts)
  assert.equal(human.code, 0, human.stderr)
  assert.deepEqual(human.lines, [
    `Organization org-1 · key …${KEY.slice(-4)}`,
    `Control plane ${ORG_API}`,
    'App crm · environment main',
    'Environments main live',
    'CLI 0.3.14 (latest 0.9.0)',
    `next: update the CLI: \`npm install -g ${CLI_RELEASE.url}\``,
  ])
  const json = JSON.parse((await cli(['whoami', '--json'], opts)).stdout)
  assert.deepEqual(json.cli, {
    version: '0.3.14',
    latest_version: '0.9.0',
    update_available: true,
    update_command: `npm install -g ${CLI_RELEASE.url}`,
  })
  assert.equal(json.organization_id, 'org-1')
  assert.equal(json.scope, 'organization')
  assert.deepEqual(json.linked, { link_file: true, app: 'crm' })
  agent.assertNoPendingInterceptors()
})

test('whoami without an App still uses the published CLI artifact URL', async () => {
  const dir = await project(root, {})
  const { agent, pool } = mockApi()
  organizationIdentity(pool)
  orgCliVersion(pool)
  const result = await cli(['whoami', '--json'], {
    cwd: dir,
    env: ORG_ENV,
    dispatcher: agent,
  })
  assert.equal(result.code, 0, result.stderr)
  const info = JSON.parse(result.stdout)
  assert.equal(info.app, null)
  assert.equal(info.organization_id, 'org-1')
  assert.equal(info.cli.update_command, `npm install -g ${CLI_RELEASE.url}`)
  agent.assertNoPendingInterceptors()
})

test('an explicit App cannot reuse another linked App project', async () => {
  const dir = await project(root, { '.boxlite/link.json': orgLink() })
  const { agent } = mockApi()
  const res = await cli(['init', '--app', 'other', '--json'], { cwd: dir, dispatcher: agent, env: ORG_ENV })
  assert.equal(JSON.parse(res.stderr).error.code, 'invalid_link')
  assert.match(res.stderr, /linked to crm, but --app selects other/)
  assert.equal(await readFile(join(dir, '.boxlite/link.json'), 'utf8'), orgLink())
})

test('docs lists topics, prints one offline, follows aliases, and filters the reference', async () => {
  const dir = await project(root, {})
  const list = JSON.parse((await cli(['docs', '--json'], { cwd: dir, env: {} })).stdout)
  assert.ok(list.topics.some((t: { topic: string }) => t.topic === 'runtime'))
  const runtime = await cli(['docs', 'runtime'], { cwd: dir, env: {} })
  assert.equal(runtime.code, 0)
  assert.match(runtime.lines[0] ?? '', /^## 3\. Runtime rules/)
  const alias = JSON.parse((await cli(['docs', 'setup', '--json'], { cwd: dir, env: {} })).stdout)
  assert.equal(alias.topic, 'install')
  const ref = await cli(['docs', 'reference', 'app', 'logs'], { cwd: dir, env: {} })
  assert.match(ref.stdout, /^### `boxlite-app app logs`/)
  assert.match(ref.stdout, /--grep <regex>/)
  const unknown = await cli(['docs', 'nope', '--json'], { cwd: dir, env: {} })
  assert.equal(unknown.code, 4)
  assert.match(JSON.parse(unknown.stderr).error.next, /lists the topics: install, /)
})

test('app context renders the environment as markdown, and --json returns the AgentContext', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) })
  const { agent, pool } = mockApi()
  const c = context({
    next_actions: [
      {
        id: 'pending_migrations',
        severity: 'warn',
        title: '1 migration(s) not applied: 0002_x.sql',
        fix: '`boxlite-app apply --yes`',
      },
    ],
    recent_errors: [{ ts: NOW, source: 'web', line: 'TypeError: boom', deployment: 2 }],
  })
  pool
    .intercept({ path: '/apps/crm/envs/main/context', method: 'GET' })
    .reply(200, c, { headers: JSON_HEADERS })
    .times(2)
  const md = await cli(['app', 'context'], { cwd: dir, dispatcher: agent })
  assert.equal(md.code, 0, md.stderr)
  for (const part of [
    '# crm · main',
    '- Status: **live** (live: #2, spec v2)',
    '- **warn** 1 migration(s) not applied: 0002_x.sql',
    '  - fix: `boxlite-app apply --yes`',
    '| web | yes | node server.js | /healthz | running | healthy | 0 | — |',
    '### deals',
    '| id | integer | no | — |',
    '- uploads at `/data/uploads` (rw); list it with `boxlite-app app volume ls uploads`',
    '| OPENAI_API_KEY | (secret, set) | secret org/openai |',
    `${NOW} [web] TypeError: boom`,
  ]) {
    assert.ok(md.stdout.includes(part), `missing: ${part}`)
  }
  const json = await cli(['app', 'context', '--json'], { cwd: dir, dispatcher: agent })
  assert.deepEqual(JSON.parse(json.stdout), c)
})

test('doctor runs local and online checks and ranks the problems with fixes', async () => {
  const dir = await project(root, {
    'boxlite.toml': `${BASE_TOML}[database]\n`,
    'package.json': '{}',
    'migrations/0001_init.sql': 'create table deals (id int);',
    'migrations/0002_more.sql': 'alter table deals add column x int;',
    '.boxlite/link.json': orgLink(2),
  })
  const { agent, pool } = mockApi()
  organizationIdentity(pool, 2)
  orgCliVersion(pool, 2)
  pool
    .intercept({ path: `${ORG_PATH}/apps/crm`, method: 'GET' })
    .reply(200, APP_INFO, { headers: JSON_HEADERS })
    .times(2)
  const failed = context({
    deployments: [
      {
        number: 3,
        kind: 'deploy',
        status: 'failed',
        message: null,
        created_at: NOW,
        finished_at: NOW,
        spec_version: null,
        error: {
          step: 'start',
          message: 'service web failed its health check within 1m0s',
          log_tail: [
            '[system] health check for web (http://127.0.0.1:20001/healthz): unhealthy after 1m0s (1 attempt(s), last: HTTP 404)',
          ],
        },
      },
      ...context().deployments,
    ],
  })
  pool
    .intercept({ path: `${ORG_PATH}/apps/crm/envs/main/context`, method: 'GET' })
    .reply(200, failed, { headers: JSON_HEADERS })
    .times(2)
  const sha = (await import('node:crypto')).createHash('sha256').update('create table deals (id int);').digest('hex')
  pool
    .intercept({ path: `${ORG_PATH}/apps/crm/envs/main/db/applied`, method: 'GET' })
    .reply(200, [{ file: '0001_init.sql', sha256: sha, deployment: 2, applied_at: NOW }], { headers: JSON_HEADERS })
    .times(2)
  pool
    .intercept({ path: `${ORG_PATH}/apps/crm/envs/main/probe`, method: 'GET' })
    .reply(
      200,
      {
        url: 'https://cp.test/crm/healthz',
        path: '/healthz',
        status: 200,
        ok: true,
        ms: 12,
        starting: false,
        reason: 'ok',
        content_type: 'text/plain',
        body_head: 'ok',
      },
      { headers: JSON_HEADERS },
    )
    .times(2)

  const opts = { cwd: dir, dispatcher: agent, env: ORG_ENV }
  const json = await cli(['doctor', '--json'], opts)
  assert.equal(json.code, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.ok, false)
  assert.deepEqual(
    report.problems.map((p: { id: string; severity: string }) => [p.id, p.severity]),
    [
      ['deploy_failed', 'error'],
      ['lockfile', 'warn'],
      ['cli_version', 'warn'],
      ['pending_migrations', 'warn'],
    ],
  )
  assert.match(report.problems[0].fix, /GET \/healthz/)
  const checks = Object.fromEntries(report.checks.map((c: { id: string; status: string }) => [c.id, c.status]))
  assert.equal(checks.key, 'ok')
  assert.equal(checks.manifest, 'ok')
  assert.equal(checks.reachable, 'ok')
  assert.equal(checks.database, 'ok')

  const human = await cli(['doctor'], opts)
  assert.equal(human.lines[0], 'Doctor · crm/main · CLI 0.3.14')
  assert.match(
    human.lines[1] ?? '',
    /^x error deployment #3 failed at start: web answers 404 on its health path \/healthz/,
  )
  assert.match(human.lines.at(-1) ?? '', /^next: add a route GET \/healthz/)
})

test('doctor with a rejected key reports it first and skips the online checks', async () => {
  const dir = await project(root, { 'boxlite.toml': BASE_TOML, 'package-lock.json': '{}', 'package.json': '{}' })
  const { agent, pool } = mockApi()
  pool
    .intercept({ path: '/api/v1/me', method: 'GET' })
    .reply(401, { message: 'Invalid credentials', statusCode: 401 }, { headers: JSON_HEADERS })
  const res = await cli(['doctor', '--json'], { cwd: dir, dispatcher: agent, env: ORG_ENV })
  assert.equal(res.code, 0, res.stderr)
  const report = JSON.parse(res.stdout)
  assert.deepEqual(
    report.problems.map((p: { id: string }) => p.id),
    ['key'],
  )
  assert.match(report.problems[0].fix, /BOXLITE_API_KEY/)
  assert.ok(report.checks.some((c: { id: string; status: string }) => c.id === 'online' && c.status === 'skipped'))
})

test('one organization login supplies the key for multiple Apps, and logout forgets it', async () => {
  const dir = await project(root, {})
  const config = await project(root, {})
  const { agent, pool } = mockApi()
  organizationIdentity(pool, 2)
  orgCliVersion(pool)
  const login = await cli(['login', '--json'], {
    cwd: dir,
    dispatcher: agent,
    env: { ...ORG_ENV, BOXLITE_CONFIG_DIR: config },
  })
  assert.equal(login.code, 0, login.stderr)
  assert.ok(!login.stdout.includes(KEY), 'the key is never printed')
  assert.equal(JSON.parse(login.stdout).organization_id, 'org-1')
  const saved = join(config, 'credentials.json')
  assert.equal((await stat(saved)).mode & 0o777, 0o600, 'readable by the user only')
  assert.deepEqual(Object.keys(JSON.parse(await readFile(saved, 'utf8')).profiles), [ORG_API])

  const opts = { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } }
  const later = await cli(['whoami', '--json'], opts)
  assert.equal(later.code, 0, later.stderr)
  assert.equal(JSON.parse(later.stdout).app, null)
  for (const app of ['crm', 'ledger']) {
    pool
      .intercept({
        path: `${ORG_PATH}/apps/${app}/envs/main/services`,
        method: 'GET',
        headers: { authorization: `Bearer ${KEY}` },
      })
      .reply(200, [], { headers: JSON_HEADERS })
    const services = await cli(['app', 'services', '--app', app, '--json'], opts)
    assert.equal(services.code, 0, services.stderr)
  }
  assert.equal((await cli(['logout'], opts)).code, 0)
  const after = await cli(['whoami', '--json'], { ...opts, env: { ...opts.env, BOXLITE_API_URL: ORG_API } })
  assert.equal(JSON.parse(after.stderr).error.code, 'unauthenticated', 'nothing saved any more')
  agent.assertNoPendingInterceptors()
})

test('login rejects a key issued for another organization', async () => {
  const dir = await project(root, {})
  const config = await project(root, {})
  const { agent, pool } = mockApi()
  pool
    .intercept({ path: '/api/v1/me', method: 'GET' })
    .reply(200, { ...IDENTITY, path_prefix: 'org-2' }, { headers: JSON_HEADERS })
  const result = await cli(['login', '--json'], {
    cwd: dir,
    dispatcher: agent,
    env: { ...ORG_ENV, BOXLITE_CONFIG_DIR: config },
  })
  assert.equal(JSON.parse(result.stderr).error.code, 'forbidden')
  await assert.rejects(stat(join(config, 'credentials.json')), { code: 'ENOENT' })
})

test('two saved organizations require an API URL, and a project link selects the matching key', async () => {
  const dir = await project(root, {})
  const config = await project(root, {})
  const other = 'blk_live_' + 'b'.repeat(32)
  const { agent, pool } = mockApi()
  organizationIdentity(pool, 2)
  orgCliVersion(pool)
  pool
    .intercept({ path: '/api/v1/me', method: 'GET', headers: { authorization: `Bearer ${other}` } })
    .reply(200, { sub: 'user-2', path_prefix: 'org-2' }, { headers: JSON_HEADERS })
  pool
    .intercept({ path: `${ORG_PATH}/apps/crm`, method: 'GET', headers: { authorization: `Bearer ${KEY}` } })
    .reply(200, APP_INFO, { headers: JSON_HEADERS })
  const opts = { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } }
  for (const env of [ORG_ENV, { BOXLITE_API_URL: API + '/api/v1/org-2', BOXLITE_API_KEY: other }]) {
    const login = await cli(['login'], { ...opts, env: { ...opts.env, ...env } })
    assert.equal(login.code, 0, login.stderr)
  }
  const unnamed = await cli(['whoami', '--json'], opts)
  assert.equal(JSON.parse(unnamed.stderr).error.code, 'missing_api_url')

  const linked = await project(root, { '.boxlite/link.json': orgLink() })
  const named = await cli(['whoami', '--json'], { ...opts, cwd: linked })
  assert.equal(named.code, 0, named.stderr)
  assert.equal(JSON.parse(named.stdout).app, 'crm')
  assert.equal(JSON.parse(named.stdout).organization_id, 'org-1')
  agent.assertNoPendingInterceptors()
})

test('an explicit environment key takes precedence over a saved organization key', async () => {
  const dir = await project(root, {})
  const config = await project(root, {})
  const invalid = 'blk_live_' + 'b'.repeat(32)
  const { agent, pool } = mockApi()
  organizationIdentity(pool)
  pool
    .intercept({ path: '/api/v1/me', method: 'GET', headers: { authorization: `Bearer ${invalid}` } })
    .reply(401, { statusCode: 401, message: 'Invalid credentials' }, { headers: JSON_HEADERS })
  const opts = { cwd: dir, dispatcher: agent, env: { BOXLITE_CONFIG_DIR: config } }
  const login = await cli(['login'], { ...opts, env: { ...opts.env, ...ORG_ENV } })
  assert.equal(login.code, 0, login.stderr)
  const later = await cli(['whoami', '--json'], {
    ...opts,
    env: { ...opts.env, BOXLITE_API_KEY: invalid },
  })
  assert.equal(JSON.parse(later.stderr).error.code, 'unauthenticated')
  assert.ok(!later.stderr.includes(invalid))
  agent.assertNoPendingInterceptors()
})

test('app remember, recall and forget keep notes for the next session', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) })
  const { agent, pool } = mockApi()
  let sent: Record<string, unknown> = {}
  pool.intercept({ path: '/apps/crm/notes', method: 'POST' }).reply(
    201,
    (opts) => {
      sent = JSON.parse(String(opts.body))
      return { id: 7, text: String(sent.text), by: 'key:…aaaa', created_at: '2026-10-24T10:00:00.000Z' }
    },
    { headers: JSON_HEADERS },
  )
  const kept = await cli(['app', 'remember', 'the', 'owner', 'wants', 'CNY'], { cwd: dir, dispatcher: agent })
  assert.equal(kept.code, 0, kept.stderr)
  assert.deepEqual(sent, { text: 'the owner wants CNY' })
  assert.match(kept.stdout, /kept note 7: the owner wants CNY/)
  pool
    .intercept({ path: '/apps/crm/notes?q=cny', method: 'GET' })
    .reply(200, [{ id: 7, text: 'the owner wants CNY', by: 'key:…aaaa', created_at: '2026-10-24T10:00:00.000Z' }], {
      headers: JSON_HEADERS,
    })
  const found = await cli(['app', 'recall', 'cny'], { cwd: dir, dispatcher: agent })
  assert.deepEqual(found.lines, ['   7  2026-10-24  the owner wants CNY'])
  pool
    .intercept({ path: '/apps/crm/notes/7', method: 'DELETE' })
    .reply(200, { forgotten: 7 }, { headers: JSON_HEADERS })
  assert.equal((await cli(['app', 'forget', '7'], { cwd: dir, dispatcher: agent })).code, 0)
  assert.equal(
    JSON.parse((await cli(['app', 'forget', 'x', '--json'], { cwd: dir, dispatcher: agent })).stderr).error.code,
    'usage',
  )
})

test('app ack sends the reason; app unack brings the finding back', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) })
  const { agent, pool } = mockApi()
  let sent: Record<string, unknown> = {}
  pool.intercept({ path: '/apps/crm/envs/main/findings/public_anonymous/ack', method: 'POST' }).reply(
    200,
    (opts) => {
      sent = JSON.parse(String(opts.body))
      return {
        id: 'public_anonymous',
        title: 'the app is public and has no sign-in',
        reason: String(sent.reason),
        by: 'key:…aaaa',
        at: '2026-10-24T10:00:00.000Z',
      }
    },
    { headers: JSON_HEADERS },
  )
  const r = await cli(['app', 'ack', 'public_anonymous', 'the', 'user', 'asked', 'for', 'it'], {
    cwd: dir,
    dispatcher: agent,
  })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(sent, { reason: 'the user asked for it' })
  assert.match(r.stdout, /acknowledged public_anonymous in main: the user asked for it/)
  pool
    .intercept({ path: '/apps/crm/envs/main/findings/public_anonymous/ack', method: 'DELETE' })
    .reply(200, { unacknowledged: 'public_anonymous' }, { headers: JSON_HEADERS })
  assert.match(
    (await cli(['app', 'unack', 'public_anonymous'], { cwd: dir, dispatcher: agent })).stdout,
    /public_anonymous is back in next_actions/,
  )
})

test('app domains add prints the DNS records the user adds; verify says when the CNAME is not there yet', async () => {
  const dir = await project(root, { '.boxlite/link.json': linkJson(1) })
  const { agent, pool } = mockApi()
  const view = {
    host: 'shop.acme.com',
    env: 'main',
    status: 'pending_dns',
    verified_at: null,
    records: [
      { type: 'TXT', name: '_boxlite-challenge.shop.acme.com', value: 'boxlite-verify=abc' },
      { type: 'CNAME', name: 'shop.acme.com', value: 'domains.proxy.test' },
    ],
  }
  pool.intercept({ path: '/apps/crm/envs/main/domains', method: 'POST' }).reply(201, view, { headers: JSON_HEADERS })
  const added = await cli(['app', 'domains', 'add', 'shop.acme.com'], { cwd: dir, dispatcher: agent })
  assert.equal(added.code, 0, added.stderr)
  assert.deepEqual(added.lines.slice(0, 3), [
    'shop.acme.com added to main; the user adds these records at their DNS provider:',
    '  TXT   _boxlite-challenge.shop.acme.com  →  boxlite-verify=abc',
    '  CNAME shop.acme.com  →  domains.proxy.test',
  ])
  pool
    .intercept({ path: '/apps/crm/envs/main/domains/shop.acme.com/verify', method: 'POST' })
    .reply(200, { ...view, status: 'active', cname: null, cname_ok: false }, { headers: JSON_HEADERS })
  const v = await cli(['app', 'domains', 'verify', 'shop.acme.com'], { cwd: dir, dispatcher: agent })
  assert.match(v.stdout, /shop\.acme\.com verified: it serves main/)
  assert.match(v.stdout, /CNAME does not point at domains\.proxy\.test yet/)
})
