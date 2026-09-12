import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SIGN_OUT_COMMANDS, signOut } from '../src/auth/sessions.ts'
import { run } from '../src/cli/run.ts'

const configRoot = (login: Record<string, { required?: boolean }>) => {
  const root = mkdtempSync(join(tmpdir(), 'mstage-logout-'))
  // Two files, as a real checkout has: what the repository is, and the stage
  // that says which cloud it lives in and what reaching it costs.
  writeFileSync(join(root, 'mstage.env.json'), JSON.stringify({ app: 'a' }))
  writeFileSync(
    join(root, '.mstage.config.json'),
    JSON.stringify({ stages: { dev: { home: 'aws', region: 'ap-southeast-1', login } } }),
  )
  return root
}

test('each provider knows the command that ends its session', () => {
  assert.deepEqual(SIGN_OUT_COMMANDS, {
    aws: [['aws', 'logout']],
    // Two, because one sign-in wrote two credentials.
    gcp: [
      ['gcloud', 'auth', 'revoke'],
      ['gcloud', 'auth', 'application-default', 'revoke'],
    ],
    github: [['gh', 'auth', 'logout']],
    auth0: [['auth0', 'logout']],
  })
})

test('a GCP sign-out ends both credentials the sign-in wrote', () => {
  // `auth revoke` alone leaves the ADC file on the machine and
  // `application-default revoke` alone leaves the account signed in, so either
  // on its own reports an ended session over one that half survives.
  const calls: string[] = []
  const runCommand = (command: string, args: string[]) => {
    calls.push([command, ...args].join(' '))
    return { status: 0 }
  }
  assert.deepEqual(signOut('gcp', runCommand as any), { ok: true })
  assert.deepEqual(calls, ['gcloud auth revoke', 'gcloud auth application-default revoke'])
})

test('a failed step does not spare the credential the next one ends', () => {
  // Revoking with no active account fails the first step while ADC is still on
  // disk. Stopping there would report the failure and leave the credential.
  const calls: string[] = []
  const runCommand = (command: string, args: string[]) => {
    calls.push([command, ...args].join(' '))
    return { status: args[1] === 'revoke' ? 1 : 0 }
  }
  assert.deepEqual(signOut('gcp', runCommand as any), { ok: false, detail: 'gcloud auth revoke exited with 1' })
  assert.deepEqual(calls, ['gcloud auth revoke', 'gcloud auth application-default revoke'])
})

test('a sign-out inherits the terminal, because gh asks which account', () => {
  const calls: any[] = []
  const runCommand = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options })
    return { status: 0 }
  }
  assert.deepEqual(signOut('github', runCommand as any), { ok: true })
  assert.deepEqual(calls, [{ command: 'gh', args: ['auth', 'logout'], options: { stdio: 'inherit' } }])
})

test('a failed sign-out names the command that failed', () => {
  assert.deepEqual(signOut('auth0', (() => ({ status: 1 })) as any), {
    ok: false,
    detail: 'auth0 logout exited with 1',
  })
})

const invoke = async ({
  argv,
  login = { github: { required: true } },
  ready = true,
}: {
  argv: string[]
  login?: Record<string, { required?: boolean }>
  ready?: boolean
}) => {
  const signedOut: string[] = []
  const signedIn: string[] = []
  const asked: string[] = []
  const lines: string[] = []
  const code = await run({
    argv,
    cwd: configRoot(login),
    environment: { AWS_REGION: 'ap-southeast-1' },
    log: (line: string) => lines.push(line),
    interactive: true,
    confirm: async (question: string) => {
      asked.push(question)
      return true
    },
    signInWith: (provider: string) => {
      signedIn.push(provider)
      return { ok: true }
    },
    signOutWith: (provider: string) => {
      signedOut.push(provider)
      return { ok: true }
    },
    checks: {
      aws: async () => status('aws'),
      gcp: async () => status('gcp'),
      github: async () => status('github'),
      auth0: async () => status('auth0'),
    },
  } as any)
  function status(provider: string) {
    return ready
      ? { provider, state: 'ready', detail: 'signed in', expiresAt: null }
      : { provider, state: 'not signed in', detail: 'no session', expiresAt: null }
  }
  return { code, signedOut, signedIn, asked, text: lines.join('\n') }
}

test('--logout ends only the named provider and announces the command', async () => {
  const { signedOut, text } = await invoke({ argv: ['login', 'github', '--logout'] })
  assert.deepEqual(signedOut, ['github'])
  assert.match(text, /github {2}signing out: gh auth logout/)
})

test('a two-command sign-out announces both, in the order they run', async () => {
  const { text } = await invoke({ argv: ['login', 'gcp', '--logout'], login: { gcp: { required: true } } })
  assert.match(text, /gcp {5}signing out: gcloud auth revoke then gcloud auth application-default revoke/)
})

test('--logout without a provider ends every one this repository declares', async () => {
  const { signedOut } = await invoke({
    argv: ['login', '--logout'],
    login: { aws: { required: true }, auth0: { required: false } },
  })
  assert.deepEqual(signedOut, ['aws', 'auth0'])
})

test('after signing out nobody is offered a sign-in', async () => {
  // The guided prompt exists for someone who wants a session, which is the
  // opposite of what --logout just asked for.
  const { asked, signedIn, code } = await invoke({ argv: ['login', 'github', '--logout'], ready: false })
  assert.deepEqual(asked, [])
  assert.deepEqual(signedIn, [])
  assert.equal(code, 1, 'the report still says the required session is gone')
})

test('--logout and --force together are refused rather than ordered', async () => {
  await assert.rejects(
    () => invoke({ argv: ['login', 'github', '--logout', '--force'] }),
    /--logout and --force ask for opposite things/,
  )
})
