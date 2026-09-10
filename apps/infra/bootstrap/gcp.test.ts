// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { GcpBootstrapError, attributeCondition, bootstrapGcp, type Run, type RunResult } from './gcp.js'

const GITHUB = {
  issuer: 'https://token.actions.githubusercontent.com',
  owner: 'boxlite-ai',
  ownerId: '123456',
  repository: 'boxlite',
  repositoryId: '789012',
}

/** The calls this file treats as questions rather than changes. */
const QUERIES = [
  'secrets describe',
  'secrets versions access',
  'storage buckets describe',
  'iam workload-identity-pools describe',
  'iam workload-identity-pools providers describe',
  'iam service-accounts describe',
  'artifacts repositories describe',
]

/**
 * A `run` that records what it was asked to do. `existing` decides how the
 * existence questions are answered; every change succeeds, which is what
 * makes a failing change its own test below.
 */
const recorder = ({ existing = false, readsBeforeVisible = 0 } = {}) => {
  const calls: string[][] = []
  const stdin: string[] = []
  /*
   * How many `describe` reads a just-created service account answers NOT_FOUND
   * for before it is visible. Zero is an API that is immediately consistent;
   * the real one is not, and answers `Service account <email> does not exist`
   * to the grant that follows `create`. Modelled per account, because that is
   * how the window behaves.
   */
  const pending = new Map<string, number>()
  const run: Run = async (command, args, options = {}) => {
    calls.push([command, ...args])
    if (options.stdin !== undefined && options.stdin !== '') stdin.push(options.stdin)
    const asked = args.join(' ')
    if (asked.startsWith('iam service-accounts create')) {
      pending.set(`${args[3]}@boxlite-gcp-dev.iam.gserviceaccount.com`, readsBeforeVisible)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (asked.startsWith('iam service-accounts describe')) {
      const email = args[3] as string
      if (!pending.has(email)) return existing ? { code: 0, stdout: '{}', stderr: '' } : { code: 254, stdout: '', stderr: 'NOT_FOUND' }
      const left = pending.get(email) as number
      if (left <= 0) return { code: 0, stdout: '{}', stderr: '' }
      pending.set(email, left - 1)
      return { code: 254, stdout: '', stderr: 'NOT_FOUND' }
    }
    /*
     * The refusal the propagation window actually produces. A grant attempted
     * before the account is visible does not queue — it fails, naming as absent
     * the account the line above created.
     */
    if (asked.startsWith('projects add-iam-policy-binding')) {
      const member = args.find((argument) => argument.startsWith('--member=serviceAccount:'))
      const email = member?.replace('--member=serviceAccount:', '') ?? ''
      if ((pending.get(email) ?? 0) > 0) {
        return { code: 1, stdout: '', stderr: `INVALID_ARGUMENT: Service account ${email} does not exist.` }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (asked.startsWith('projects describe')) return { code: 0, stdout: '999999999999\n', stderr: '' }
    // A project already bootstrapped names its bucket here, which is what makes
    // the re-run path reachable at all; an absent record is the first run.
    if (asked.startsWith('secrets versions access')) {
      return existing
        ? { code: 0, stdout: JSON.stringify({ state: 'mstage-state-0123456789abcdef' }), stderr: '' }
        : { code: 254, stdout: '', stderr: 'NOT_FOUND' }
    }
    // Nothing enabled yet, so every service in the list is missing.
    if (asked.startsWith('services list')) return { code: 0, stdout: '', stderr: '' }
    if (QUERIES.some((query) => asked.startsWith(query))) {
      return existing ? { code: 0, stdout: '{}', stderr: '' } : { code: 254, stdout: '', stderr: 'NOT_FOUND' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const applied = (...needles: string[]): string[][] =>
    calls.filter((call) => needles.every((needle) => call.join(' ').includes(needle)))
  return { run, calls, stdin, applied }
}

/** One invocation, with the coordinates a real run would read from mstage/mbuild config. */
const invoke = (run: Run) =>
  bootstrapGcp({
    run,
    project: 'boxlite-gcp-dev',
    region: 'asia-southeast1',
    app: 'boxlite',
    stage: 'gcp-dev',
    repository: 'boxlite-app-gcp-dev',
    immutableTags: true,
    github: GITHUB,
    log: () => {},
    // The retry is proved without spending it; the real default is a timer.
    wait: async () => {},
  })

test('a fresh project gets every prerequisite mdeploy and mbuild cannot create for themselves', async () => {
  const gcloud = recorder()
  const result = await invoke(gcloud.run)

  assert.equal(gcloud.applied('services enable').length, 1, 'no APIs were enabled')
  assert.equal(gcloud.applied('storage buckets create').length, 1, 'no state bucket')
  assert.equal(gcloud.applied('storage buckets update', '--versioning').length, 1, 'the bucket is unversioned')
  assert.equal(gcloud.applied('secrets create', 'mstage-bootstrap').length, 1, 'nothing names the bucket')
  assert.equal(
    gcloud.applied('secrets create', 'mstage-passphrase-boxlite-gcp-dev').length,
    1,
    'the store has nothing to be sealed with',
  )
  assert.equal(gcloud.applied('workload-identity-pools create').length, 1, 'no pool for CI to federate into')
  assert.equal(gcloud.applied('providers create-oidc').length, 1, 'no provider trusting GitHub')
  assert.equal(gcloud.applied('service-accounts create', 'boxlite-gcp-dev-deploy').length, 1, 'no deployer')
  assert.equal(gcloud.applied('service-accounts create', 'boxlite-mbuild').length, 1, 'no image publisher')
  assert.equal(gcloud.applied('artifacts repositories create', 'boxlite-app-gcp-dev').length, 1, 'no docker repository')
  /*
   * The declaration mbuild reads, honoured at the one moment it can be: tag
   * immutability is fixed at creation and no command changes it afterwards. A
   * repository made without it is one mbuild then refuses to publish into, so
   * the mismatch costs a repository that has to be deleted by hand.
   */
  assert.ok(
    gcloud.applied('artifacts repositories create', '--immutable-tags').length === 1,
    'the repository was created with movable tags',
  )

  assert.equal(result.deployerEmail, 'boxlite-gcp-dev-deploy@boxlite-gcp-dev.iam.gserviceaccount.com')
  assert.equal(result.publisherEmail, 'boxlite-mbuild@boxlite-gcp-dev.iam.gserviceaccount.com')
  assert.match(result.workloadIdentityProvider, /^projects\/999999999999\/.*\/workloadIdentityPools\/boxlite\/providers\/github$/)
})

test('re-running reconciles what is there instead of creating it again', async () => {
  const gcloud = recorder({ existing: true })
  await invoke(gcloud.run)

  for (const created of ['service-accounts create', 'storage buckets create', 'secrets create']) {
    assert.deepEqual(gcloud.applied(created), [], `${created} ran against a project that already has it`)
  }
  assert.deepEqual(gcloud.applied('workload-identity-pools create'), [])
  assert.deepEqual(gcloud.applied('artifacts repositories create'), [])
  // The provider is still reapplied: its attribute condition is the fence, and
  // a rerun with a different repository has to reach GCP somehow.
  assert.equal(gcloud.applied('providers update-oidc').length, 1)
})

test('every call carries the project and never waits on a prompt', async () => {
  const gcloud = recorder()
  await invoke(gcloud.run)
  assert.ok(gcloud.calls.length > 0)
  for (const call of gcloud.calls) {
    assert.equal(call[0], 'gcloud')
    assert.ok(call.includes('boxlite-gcp-dev'), `no project on: ${call.join(' ')}`)
    assert.ok(call.includes('--quiet'), `no --quiet on: ${call.join(' ')}`)
  }
})

test('the deployer may act as the stage environment, and the publisher as main and the stage', async () => {
  const gcloud = recorder()
  await invoke(gcloud.run)

  const deployerGrant = gcloud
    .applied('service-accounts add-iam-policy-binding', 'boxlite-gcp-dev-deploy@')[0]!
    .join(' ')
  assert.match(deployerGrant, /attribute\.environment\/gcp-dev/)

  const publisherGrants = gcloud.applied('service-accounts add-iam-policy-binding', 'boxlite-mbuild@')
  assert.equal(publisherGrants.length, 2, 'the publisher needs both claim shapes')
  assert.ok(publisherGrants.some((call) => call.join(' ').includes('attribute.ref/refs/heads/main')))
  assert.ok(publisherGrants.some((call) => call.join(' ').includes('attribute.environment/gcp-dev')))
})

test('a service account is probed by the name gcloud accepts, not the one it is created with', async () => {
  // `create` takes the bare id and `describe` takes the full email — probing
  // with the id would make every re-run try to create an account already there.
  const gcloud = recorder()
  await invoke(gcloud.run)
  const probes = gcloud.applied('service-accounts describe')
  assert.ok(probes.length >= 2, 'the deployer and the publisher are both probed')
  for (const probe of probes) {
    assert.ok(probe.some((argument) => argument.endsWith('.iam.gserviceaccount.com')), `probed with: ${probe.join(' ')}`)
  }
})

test('a service account is granted its roles on the run that created it', async () => {
  /*
   * `create` returns before the account is visible to the IAM policy API, so
   * the grant that follows was refused with `Service account <email> does not
   * exist` — naming as absent the account the line above had just made. A first
   * bootstrap died there with the deployer created and none of its twelve roles
   * attached, and only a second run completed. Reconciling on re-run is not the
   * same as working.
   */
  const gcloud = recorder({ readsBeforeVisible: 2 })
  const result = await invoke(gcloud.run)

  const grants = gcloud.applied('projects add-iam-policy-binding', 'boxlite-gcp-dev-deploy@')
  assert.equal(grants.length, 12, 'the deployer did not receive every role')
  assert.ok(result.deployerEmail.startsWith('boxlite-gcp-dev-deploy@'))
  // The wait is a read loop, not a blind sleep: it stops as soon as the account
  // answers, so an immediately consistent API costs one extra read and no time.
  const probes = gcloud.applied('service-accounts describe', 'boxlite-gcp-dev-deploy@')
  assert.equal(probes.length, 4, `expected one absent probe, two retries and the answer: ${probes.length}`)
})

test('an account that never becomes visible is reported rather than waited on forever', async () => {
  // The budget is finite: the grant below reports its own refusal, which names
  // the role it was attaching and says more than a timeout here would.
  const gcloud = recorder({ readsBeforeVisible: 99 })
  await assert.rejects(() => invoke(gcloud.run), /Could not grant \S+ to boxlite-gcp-dev-deploy@/)
})

test('neither secret reaches the process table', async () => {
  const gcloud = recorder()
  await invoke(gcloud.run)
  for (const call of gcloud.applied('secrets create')) {
    assert.ok(call.includes('--data-file=-'), `a secret was not fed through stdin: ${call.join(' ')}`)
  }
  assert.equal(gcloud.stdin.length, 2, 'expected the bootstrap record and the passphrase')
  const passphrase = gcloud.stdin.find((value) => !value.startsWith('{'))
  assert.ok(passphrase, 'no passphrase was written')
  assert.equal(Buffer.from(passphrase, 'base64').length, 32)
})

test('the state bucket never reaches the log', async () => {
  const gcloud = recorder()
  const lines: string[] = []
  await bootstrapGcp({
    run: gcloud.run,
    project: 'boxlite-gcp-dev',
    region: 'asia-southeast1',
    app: 'boxlite',
    stage: 'gcp-dev',
    repository: 'boxlite-app-gcp-dev',
    immutableTags: true,
    github: GITHUB,
    log: (line) => lines.push(line),
  })
  const created = gcloud.applied('storage buckets create')[0]!
  const bucket = created.find((argument) => argument.startsWith('gs://'))!.replace('gs://', '')
  assert.match(bucket, /^mstage-state-[0-9a-f]{16}$/, 'the bucket name is guessable')
  assert.ok(!lines.some((line) => line.includes(bucket)), 'the state bucket name was logged')
})

test('the identity provider pins the repository, and never the audience', () => {
  const condition = attributeCondition(GITHUB)
  assert.match(condition, /repository_owner_id == '123456'/)
  assert.match(condition, /repository_id == '789012'/)
  assert.doesNotMatch(condition, /repository ==/, 'the condition pins a mutable name')
})

const invokeWith = (run: Run) =>
  bootstrapGcp({
    run,
    project: 'boxlite-gcp-dev',
    region: 'asia-southeast1',
    app: 'boxlite',
    stage: 'gcp-dev',
    repository: 'boxlite-app-gcp-dev',
    immutableTags: true,
    github: GITHUB,
    log: () => {},
  })

test('a project described with no number stops the run before anything is created', async () => {
  /*
   * A guard rather than a diagnosis, and the message says so instead of naming
   * a cause. Every route that was worth suspecting exits non-zero and is caught
   * one branch up — `projects describe` given a project's display name answers
   * `INVALID_ARGUMENT`, not an empty number. What is left is a success with
   * nothing in it, which nothing here can explain and every principalSet below
   * would be built from.
   *
   * The command is asserted along with the refusal. A message that can name no
   * cause has to hand over something to run, or the only way forward is to read
   * this file.
   */
  await assert.rejects(
    () => invokeWith(async () => ({ code: 0, stdout: '', stderr: '' })),
    (error: Error) => {
      assert.ok(error instanceof GcpBootstrapError)
      assert.match(error.message, /printed no project number/, 'what happened')
      assert.match(error.message, /gcloud projects describe boxlite-gcp-dev --format='value\(projectNumber\)'/, 'what to run')
      return true
    },
  )
})

test('a read that failed carries gcloud’s own words, not a guess about why', async () => {
  /*
   * The reason this is asserted rather than left to the message that reads best:
   * every call here carries `--quiet`, so a session needing reauth cannot
   * prompt and gcloud exits non-zero with `Reauthentication failed. cannot
   * prompt during non-interactive execution`. Swallowing that reported it as
   * "check that the project exists", which is the wrong place to look — and
   * `bootstrap.ts`'s `requireGhAuthenticated` keeps gh's stderr for exactly the
   * same reason.
   */
  const reauth = 'ERROR: (gcloud.projects.describe) There was a problem refreshing your current auth tokens'
  await assert.rejects(
    () => invokeWith(async () => ({ code: 1, stdout: '', stderr: reauth })),
    (error: Error) => {
      assert.ok(error instanceof GcpBootstrapError)
      assert.match(error.message, /reading the number of project boxlite-gcp-dev/, 'which read failed')
      assert.match(error.message, /problem refreshing your current auth tokens/, 'and what gcloud said about it')
      return true
    },
  )
})

test('a failing gcloud call stops the run and carries the reason', async () => {
  const run: Run = async (_command, args): Promise<RunResult> => {
    if (args.join(' ').startsWith('projects describe')) return { code: 0, stdout: '999999999999', stderr: '' }
    if (args.join(' ').startsWith('services list')) return { code: 0, stdout: '', stderr: '' }
    return { code: 1, stdout: '', stderr: 'PERMISSION_DENIED: caller lacks serviceusage.services.enable' }
  }
  await assert.rejects(
    () => invoke(run),
    (error: Error) => error instanceof GcpBootstrapError && /PERMISSION_DENIED/.test(error.message),
  )
})
