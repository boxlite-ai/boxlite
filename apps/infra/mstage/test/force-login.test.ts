import assert from 'node:assert/strict'
import test from 'node:test'
import { SIGN_IN_COMMANDS, signIn } from '../src/auth/sessions.ts'
import { requirementsFor, run } from '../src/cli/run.ts'
import { loadConfig, parseStages } from '../src/config/load.ts'

test('each provider knows the command that signs it in', () => {
  // A sequence per provider, because gcloud needs two: `auth login` writes the
  // CLI's own account and `application-default login` writes ADC with the quota
  // project. `auth login --update-adc` is the one command that looks like both
  // and drops `quota_project_id`, which no token mint can detect — sessions.ts
  // cites where gcloud decides that.
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
/**
 * The stage file this repository's own tests read.
 *
 * `.mstage.config.example.json`, not `.mstage.config.json`: the real one names
 * somebody's cloud account and is not committed, so a fresh checkout and every
 * CI run have only the example. Reading it here is also what keeps it honest —
 * a stage added to one file and not the other fails these tests rather than
 * leaving the template quietly wrong.
 */
const STAGES = { MSTAGE_CONFIG: new URL('../../.mstage.config.example.json', import.meta.url).pathname }

const captureRun = async (argv: string[]) => {
  const lines: string[] = []
  const signedIn: string[] = []
  await run({
    argv,
    environment: STAGES,
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

test('-f forces every provider the stages enable, not every one mstage knows', async () => {
  // The two lists differ: mstage knows four clouds and CLIs, and the stage
  // file says which of them this checkout needs. Forcing a sign-in nobody
  // declared opens a browser for a cloud unrelated to the work.
  const { signedIn } = await captureRun(['login', '-f'])
  const config = loadConfig({ cwd: new URL('../..', import.meta.url).pathname, environment: STAGES })
  const enabled = Object.keys(requirementsFor({ config, stage: undefined }))
  assert.deepEqual(signedIn, enabled)
  /*
   * Named rather than counted. This checkout enables all four, so a count
   * cannot tell "what the stages ask for" from "everything mstage knows" — the
   * two are the same size here. What separates them is per stage: `dev` lives
   * in AWS and has no use for a GCP sign-in, and forcing one would open a
   * browser for a cloud unrelated to the work.
   */
  const onAws = Object.keys(requirementsFor({ config, stage: 'dev' }))
  assert.ok(!onAws.includes('gcp'), 'an AWS stage asked for a GCP sign-in')
  assert.ok(onAws.length < Object.keys(SIGN_IN_COMMANDS).length, 'one stage needs fewer than mstage knows')
})

test('a stage requires the cloud it lives in, and only reports the other', () => {
  /*
   * A stage in one cloud needs no credential for the other. Read
   * repository-wide, an expired AWS session refused a GCP deploy on a machine
   * that needed no AWS credential for it.
   *
   * Parsed here rather than read from this repository's own stage file, which
   * is not committed and so cannot be relied on to have two clouds in it.
   */
  const config = {
    path: '/repo/.mstage.config.json',
    stages: parseStages(
      '/repo/.mstage.config.json',
      JSON.stringify({
        stages: {
          dev: {
            home: 'aws',
            region: 'ap-southeast-1',
            login: { aws: { required: true }, github: { required: true }, auth0: { required: false } },
          },
          'gcp-dev': {
            home: 'gcp',
            region: 'asia-southeast1',
            project: 'boxlite-gcp-dev',
            login: { gcp: { required: true }, github: { required: true } },
          },
        },
      }),
    ),
  }

  // Merged, and required wins: `auth0` is optional wherever it appears, and
  // `github` is required by both.
  const everywhere = requirementsFor({ config, stage: undefined })
  assert.equal(everywhere.aws!.required, true, 'without a stage the whole checkout is the question')
  assert.equal(everywhere.gcp!.required, true)
  assert.equal(everywhere.auth0!.required, false, 'no stage cannot do without it')

  const onGcp = requirementsFor({ config, stage: 'gcp-dev' })
  assert.equal(onGcp.gcp!.required, true, 'the stage lives in gcp and must be signed in to it')
  assert.equal(onGcp.aws, undefined, 'an AWS session is not what deploys a GCP stage')
  assert.equal(onGcp.github!.required, true, 'github is not a cloud, and this stage names it')

  const onAws = requirementsFor({ config, stage: 'dev' })
  assert.equal(onAws.aws!.required, true)
  assert.equal(onAws.gcp, undefined)
})

test('the session is read after the sign-in, not before', async () => {
  const order: string[] = []
  const lines: string[] = []
  await run({
    argv: ['login', 'github', '-f'],
    environment: STAGES,
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
  /*
   * Named with a provider this checkout declares, read rather than written
   * down: `login` refuses one no stage uses before it ever reaches a sign-in,
   * so a literal that some other repository does not declare would satisfy
   * this assertion on the wrong refusal.
   *
   * The padding is the handler's (`padEnd(8)`), so it is computed from the
   * name rather than counted out here.
   */
  const config = loadConfig({ cwd: new URL('../..', import.meta.url).pathname, environment: STAGES })
  const provider = Object.keys(requirementsFor({ config, stage: undefined }))[0]
  assert.ok(provider, 'this checkout declares no login provider to force')
  const detail = `${provider} login exited with 1`

  const lines: string[] = []
  await run({
    argv: ['login', provider, '-f'],
    environment: STAGES,
    log: (line: string) => lines.push(line),
    signInWith: () => ({ ok: false, detail }),
  })
  const text = lines.join('\n')
  assert.match(text, new RegExp(detail))
  assert.match(text, new RegExp(`${provider.padEnd(8)}(ready|not signed in)`))
})
