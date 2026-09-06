import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAuth0, checkGitHub } from '../src/auth/sessions.ts'
import { report } from '../src/cli/handlers/login.ts'

// Shapes taken from the installed CLIs: gh 2.98.0 and auth0 1.33.0.
const GH_SIGNED_IN = JSON.stringify({
  hosts: {
    'github.com': [
      { state: 'success', active: true, host: 'github.com', login: 'DefeatMan', scopes: 'repo, workflow' },
    ],
  },
})
const AUTH0_TENANTS = JSON.stringify([
  { active: false, name: 'polygala-employees-dev.us.auth0.com' },
  { active: true, name: 'polygala-employees.us.auth0.com' },
])

const cli = (result: any) => {
  const calls: any[] = []
  return {
    calls,
    runCommand: (command: string, args: string[], options: any) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: '', stderr: '', ...result }
    },
  }
}

test('a signed-in gh reports the active account and host', async () => {
  const { runCommand, calls } = cli({ stdout: GH_SIGNED_IN })
  assert.deepEqual(await checkGitHub({ runCommand }), {
    provider: 'github',
    state: 'ready',
    detail: 'DefeatMan on github.com',
    expiresAt: null,
  })
  assert.deepEqual(calls[0].args, ['auth', 'status', '--active', '--json', 'hosts'])
  assert.equal(calls[0].options.timeout, 15_000, 'a hung CLI must not hang mstage')
})

test('gh --json exits zero even when the session is broken, so state decides', async () => {
  // Documented in `gh auth status --help`; trusting the exit code would report ready.
  const broken = JSON.stringify({
    hosts: { 'github.com': [{ state: 'timeout', active: true, host: 'github.com', login: 'DefeatMan' }] },
  })
  const status = await checkGitHub({ runCommand: cli({ status: 0, stdout: broken }).runCommand })
  assert.equal(status.state, 'not signed in')
  assert.match(status.detail, /DefeatMan on github.com: timeout/)
})

test('an absent CLI says how to install it, then how to sign in', async () => {
  const enoent = () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) })
  const github = await checkGitHub({ runCommand: enoent })
  assert.equal(github.state, 'not signed in')
  assert.match(github.detail, /gh is not installed\. Install it with: brew install gh/)
  assert.match(github.detail, /Sign in with: gh auth login/)

  // The formula name differs from the binary name for the AWS CLI, so the hint
  // is read from the provider table rather than guessed from the command.
  assert.match((await checkAuth0({ runCommand: enoent })).detail, /brew install auth0/)
})

test("a failing gh surfaces the CLI's own message", async () => {
  const { runCommand } = cli({ status: 1, stderr: 'You are not logged into any GitHub hosts.' })
  const status = await checkGitHub({ runCommand })
  assert.match(status.detail, /You are not logged into any GitHub hosts\./)
  assert.match(status.detail, /gh auth login/)
})

test('gh with no active account is not signed in', async () => {
  const { runCommand } = cli({ stdout: JSON.stringify({ hosts: {} }) })
  assert.match((await checkGitHub({ runCommand })).detail, /no active account/)
})

test('a signed-in auth0 reports the active tenant, not the whole list', async () => {
  const { runCommand, calls } = cli({ stdout: AUTH0_TENANTS })
  assert.deepEqual(await checkAuth0({ runCommand }), {
    provider: 'auth0',
    state: 'ready',
    detail: 'polygala-employees.us.auth0.com',
    expiresAt: null,
  })
  assert.deepEqual(calls[0].args, ['tenants', 'list', '--json', '--no-input', '--no-color'])
})

test("a failing auth0 surfaces the CLI's own message", async () => {
  const { runCommand } = cli({ status: 1, stderr: 'Not logged in. Try `auth0 login`.' })
  const status = await checkAuth0({ runCommand })
  assert.equal(status.state, 'not signed in')
  assert.match(status.detail, /Not logged in/)
})

test('auth0 with tenants but none active is not signed in', async () => {
  const { runCommand } = cli({ stdout: JSON.stringify([{ active: false, name: 'a.us.auth0.com' }]) })
  assert.match((await checkAuth0({ runCommand })).detail, /no active tenant/)
})

test('unreadable CLI output is reported rather than thrown', async () => {
  assert.match((await checkGitHub({ runCommand: cli({ stdout: 'not json' }).runCommand })).detail, /as JSON/)
  assert.match((await checkAuth0({ runCommand: cli({ stdout: '<html>' }).runCommand })).detail, /as JSON/)
})

test('a CLI killed by the timeout is reported, not treated as signed in', async () => {
  const status = await checkAuth0({ runCommand: () => ({ signal: 'SIGTERM', status: null }) })
  assert.equal(status.state, 'not signed in')
  assert.match(status.detail, /auth0 did not finish \(SIGTERM\)/)
})

test('an optional provider that is not signed in does not fail the command', async () => {
  // boxlite-commerce never provisions Auth0; failing over it would train people
  // to ignore the output.
  const lines: string[] = []
  const log = (line: string) => lines.push(line)

  const optionalOnly = await report({
    statuses: [
      { provider: 'auth0', state: 'not signed in', detail: 'auth0 is not installed', required: false, expiresAt: null },
    ],
    log,
  })
  assert.equal(optionalOnly, 0)
  assert.match(lines.join('\n'), /auth0 {3}not signed in \(optional\)/)

  const required = await report({
    statuses: [
      { provider: 'github', state: 'not signed in', detail: 'no active account', required: true, expiresAt: null },
    ],
    log,
  })
  assert.equal(required, 1)
})
