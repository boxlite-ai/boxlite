import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SIGN_IN_COMMANDS, signIn } from '../src/auth/sessions.ts'
import { requirementsFor, run } from '../src/cli/run.ts'
import { loadConfig } from '../src/config/load.ts'

test('each provider knows the command that signs it in', () => {
  // A sequence per provider, because gcloud needs two: `auth login` writes the
  // CLI's own account and `application-default login` writes ADC with the quota
  // project. `auth login --update-adc` is the one command that looks like both
  // and drops `quota_project_id`, which no token mint can detect.
  assert.deepEqual(SIGN_IN_COMMANDS, {
    aws: [['aws', 'login']],
    gcp: [
      ['gcloud', 'auth', 'login'],
      ['gcloud', 'auth', 'application-default', 'login'],
    ],
    github: [['gh', 'auth', 'login']],
    auth0: [['auth0', 'login']],
  })
})

test('a sign-in inherits the terminal, because it prompts or opens a browser', () => {
  const calls: any[] = []
  const runCommand = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options })
    return { status: 0 }
  }
  assert.deepEqual(signIn('github', runCommand), { ok: true })
  assert.deepEqual(calls, [{ command: 'gh', args: ['auth', 'login'], options: { stdio: 'inherit' } }])
})

test('a gcp sign-in writes both credential stores, in one invocation', () => {
  /*
   * The second step is not optional decoration. `auth login` writes the CLI's
   * own account and nothing else; ADC — what the SDKs and the Pulumi provider
   * resolve — is only written by `application-default login`, and only that one
   * puts `quota_project_id` in it. Running the first alone is the bug this
   * replaced: `mstage login` reported gcp ready, and the next gcloud call died
   * on `Reauthentication failed. cannot prompt during non-interactive
   * execution`.
   */
  const ran: string[][] = []
  const runCommand = (command: string, args: string[]) => {
    ran.push([command, ...args])
    return { status: 0 }
  }
  assert.deepEqual(signIn('gcp', runCommand), { ok: true })
  assert.deepEqual(ran, [
    ['gcloud', 'auth', 'login'],
    ['gcloud', 'auth', 'application-default', 'login'],
  ])
})

test('a sign-in stops at the step that failed, where a sign-out would not', () => {
  // Deliberately the opposite policy from `signOut`: nothing is left half-done
  // by an abandoned sign-in, and sending an operator who just cancelled one
  // browser flow into a second one is noise.
  const ran: string[][] = []
  const runCommand = (command: string, args: string[]) => {
    ran.push([command, ...args])
    return { status: 1 }
  }
  assert.deepEqual(signIn('gcp', runCommand), { ok: false, detail: 'gcloud auth login exited with 1' })
  assert.deepEqual(ran, [['gcloud', 'auth', 'login']])
})

test('a failed or missing sign-in reports rather than throws', () => {
  assert.deepEqual(
    signIn('auth0', () => ({ status: 1 })),
    {
      ok: false,
      detail: 'auth0 login exited with 1',
    },
  )
  // The AWS formula is not named after its binary, so the hint is read from the
  // provider table rather than derived from the command.
  assert.deepEqual(
    signIn('aws', () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) })),
    {
      ok: false,
      detail: 'aws is not installed. Install it with: brew install awscli',
    },
  )
})

/**
 * The force path is exercised through `run`, the only place that decides whether
 * a sign-in happens. The real sign-ins are interactive — they prompt or open a
 * browser — so the seam is injected rather than letting a test fire them.
 */
const captureRun = async (argv: string[], cwd?: string) => {
  const lines: string[] = []
  const signedIn: string[] = []
  await run({
    argv,
    environment: {},
    ...(cwd ? { cwd } : {}),
    log: (line: string) => lines.push(line),
    signInWith: (provider: string) => {
      signedIn.push(provider)
      return { ok: true }
    },
  })
  return { signedIn, text: lines.join('\n') }
}

test('without --force nothing is signed in, only reported', async () => {
  const { signedIn, text } = await captureRun(['login', 'github'])
  assert.deepEqual(signedIn, [])
  assert.ok(!text.includes('signing in'), text)
})

test('--force signs in only the named provider, and announces the command', async () => {
  const { signedIn, text } = await captureRun(['login', 'github', '--force'])
  assert.deepEqual(signedIn, ['github'])
  assert.match(text, /github {2}signing in: gh auth login/)
})

test('-f forces every provider this repository enables', async () => {
  const { signedIn } = await captureRun(['login', '-f'])
  const enabled = Object.keys(loadConfig({ cwd: new URL('../..', import.meta.url).pathname }).login)
  assert.deepEqual(signedIn, enabled)
})

test('-f forces what the file declares, and never every provider mstage knows', async () => {
  /*
   * Driven against a config that declares a strict subset, rather than against
   * this repository's. BoxLite now deploys to both clouds and so declares all
   * four providers — which makes its own file unable to tell "read the config"
   * apart from "sign in to everything", the exact confusion this covers. A
   * sign-in nobody declared opens a browser for a cloud unrelated to the work.
   */
  const root = mkdtempSync(join(tmpdir(), 'mstage-login-'))
  writeFileSync(
    join(root, 'mstage.config.json'),
    JSON.stringify({
      app: 'subset',
      home: 'aws',
      login: { github: { required: true } },
      stages: { dev: { region: 'ap-southeast-1' } },
    }),
  )
  const { signedIn } = await captureRun(['login', '-f'], root)
  assert.deepEqual(signedIn, ['github'])
  assert.ok(Object.keys(SIGN_IN_COMMANDS).length > signedIn.length, 'mstage knows more than this config enables')
})

test('a stage requires the cloud it lives in, and only reports the other', async () => {
  /*
   * BoxLite declares both clouds because it has stages in both, and without a
   * stage that reads as "every deploy needs both". An expired AWS session then
   * refused a GCP deploy on a machine that needed no AWS credential to perform
   * it — the credential was for the cloud the deploy does not touch.
   *
   * The other three requirements are untouched: GitHub and Auth0 are not a
   * stage's home, and the stage's own cloud stays required.
   */
  const config = loadConfig({ cwd: new URL('../..', import.meta.url).pathname })
  const everywhere = requirementsFor({ config, stage: undefined })
  assert.equal(everywhere.aws!.required, true, 'without a stage the whole repository is the question')
  assert.equal(everywhere.gcp!.required, true)

  const onGcp = requirementsFor({ config, stage: 'dev2' })
  assert.equal(onGcp.gcp!.required, true, 'the stage lives in gcp and must be signed in to it')
  assert.equal(onGcp.aws!.required, false, 'an AWS session is not what deploys a GCP stage')
  assert.equal(onGcp.github!.required, true, 'github is not a cloud and is nobody’s home')

  const onAws = requirementsFor({ config, stage: 'dev' })
  assert.equal(onAws.aws!.required, true)
  assert.equal(onAws.gcp!.required, false)
})

test('the session is read after the sign-in, not before', async () => {
  const order: string[] = []
  const lines: string[] = []
  await run({
    argv: ['login', 'github', '-f'],
    environment: {},
    log: (line: string) => {
      lines.push(line)
      if (line.includes('github')) order.push(line.includes('signing in') ? 'sign-in' : 'report')
    },
    signInWith: () => ({ ok: true }),
  })
  assert.equal(order[0], 'sign-in', lines.join('\n'))
  assert.equal(order[1], 'report', lines.join('\n'))
})

test('a failed sign-in is reported and the check still runs', async () => {
  const lines: string[] = []
  await run({
    argv: ['login', 'auth0', '-f'],
    environment: {},
    log: (line: string) => lines.push(line),
    signInWith: () => ({ ok: false, detail: 'auth0 login exited with 1' }),
  })
  const text = lines.join('\n')
  assert.match(text, /auth0 login exited with 1/)
  assert.match(text, /auth0 {3}(ready|not signed in)/)
})
