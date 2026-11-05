import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { API, cleanup, cli, JSON_HEADERS, KEY, mockApi, project, tempDir } from './helpers.js'

let root: string
before(async () => {
  root = await tempDir()
})
after(async () => cleanup(root))

test('App commands in an unlinked directory require an explicit App', async () => {
  const dir = await project(root, {})
  const { agent } = mockApi()
  for (const command of [['app', 'services'], ['init']]) {
    const result = await cli([...command, '--json'], { cwd: dir, dispatcher: agent })
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'not_linked')
    assert.match(error.next, /boxlite-app init --app <name>/)
  }
})

test('an invalid key fails as unauthenticated when an App is selected', async () => {
  const dir = await project(root, {})
  const { agent, pool } = mockApi()
  pool.intercept({ path: '/apps/crm', method: 'GET' }).reply(
    401,
    {
      error: {
        code: 'unauthenticated',
        message: 'Invalid credentials',
      },
    },
    { headers: JSON_HEADERS },
  )
  const res = await cli(['app', 'status', '--app', 'crm', '--json'], {
    cwd: dir,
    dispatcher: agent,
    env: { BOXLITE_API_KEY: 'blk_test_wrongwrongwrongwrongwrong2345', BOXLITE_API_URL: API },
  })
  assert.equal(res.code, 2)
  assert.equal(res.stdout, '')
  const err = JSON.parse(res.stderr).error
  assert.equal(err.code, 'unauthenticated')
  assert.match(err.next, /save your organization API key/)
  assert.doesNotMatch(res.stderr, /wrongwrong/)

  const noKey = await cli(['app', 'status', '--app', 'crm'], {
    cwd: dir,
    dispatcher: agent,
    env: { BOXLITE_API_URL: API },
  })
  assert.equal(noKey.code, 2)
  assert.match(
    noKey.stderr,
    /next: save your organization API key with `BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login`/,
  )
})

test('BOXLITE_APP selects an unlinked App and --app can override it', async () => {
  const dir = await project(root, {})
  const { agent, pool } = mockApi()
  pool.intercept({ path: '/apps/crm/envs/main/services', method: 'GET' }).reply(200, [], { headers: JSON_HEADERS })
  pool.intercept({ path: '/apps/ledger/envs/main/services', method: 'GET' }).reply(200, [], { headers: JSON_HEADERS })
  const opts = {
    cwd: dir,
    dispatcher: agent,
    env: { BOXLITE_API_KEY: KEY, BOXLITE_API_URL: API, BOXLITE_APP: 'crm' },
  }
  const res = await cli(['app', 'services', '--json'], opts)
  assert.equal(res.code, 0, res.stderr)
  const explicit = await cli(['--app', 'ledger', 'app', 'services', '--json'], opts)
  assert.equal(explicit.code, 0, explicit.stderr)
  const unknown = await cli(['--app', 'ledger', 'app', 'services', '--unknown', '--json'], opts)
  assert.match(JSON.parse(unknown.stderr).error.next, /boxlite-app app services --help/)
  agent.assertNoPendingInterceptors()
})
