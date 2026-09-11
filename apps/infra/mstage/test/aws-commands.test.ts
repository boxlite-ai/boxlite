/*
 * The `mstage aws` commands, against both clouds.
 *
 * The module's name is the command's, not a constraint on what it may be handed:
 * `resolveHome` picks the cloud once and answers with an `Identity`, and
 * `run.ts` passes whichever it got straight into these handlers. Every one of
 * them therefore has to work on either — and two did not, in ways nothing here
 * covered until a stage actually had a GCP home:
 *
 *   exec    reached for an AWS key triple and died on `identity.credentials`
 *   whoami  labelled a GCP project `account` and printed `arn: undefined`
 *
 * The identities below are the real ones rather than fakes with the right
 * shape. What is being tested is whether a handler and an identity agree, so a
 * hand-written stand-in for one of them would be testing the stand-in.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { exec, whoami } from '../src/cli/handlers/aws.ts'
import { resolveGcpIdentity, type GoogleAuth } from '../src/gcp/identity.ts'
import { resolveIdentity } from '../src/aws/identity.ts'
import type { Scope } from '../src/aws/precedence.ts'

const scope = (overrides: Partial<Scope> = {}): Scope =>
  ({
    stage: 'dev',
    stageSource: '--stage',
    protect: false,
    home: 'gcp',
    project: 'boxlite-dev',
    app: 'boxlite-backoffice',
    appSource: 'mstage.env.json',
    region: 'asia-southeast1',
    regionSource: 'dev in .mstage.config.json',
    roleArn: null,
    roleArnSource: null,
    roleSessionName: null,
    ...overrides,
  }) as Scope

const googleAuth = (credentials: { client_email?: string } = {}): GoogleAuth => ({
  async getProjectId() {
    return 'boxlite-dev'
  },
  async getCredentials() {
    return credentials
  },
})

/**
 * An ambient identity for the other cloud, half-set — which is what a
 * workstation that has used both actually looks like. The child must inherit
 * none of it, so the environment a handler passes down is built from this
 * rather than from nothing; against an empty one the assertion could not fail.
 */
const AMBIENT_AWS = {
  AWS_PROFILE: 'stale',
  AWS_ACCESS_KEY_ID: 'STALE',
  AWS_SECRET_ACCESS_KEY: 'stale',
  AWS_SESSION_TOKEN: 'stale',
  PATH: '/usr/bin',
}

const onGcp = (credentials?: { client_email?: string }) =>
  resolveGcpIdentity({ scope: scope(), auth: googleAuth(credentials), environment: AMBIENT_AWS })

/**
 * The AWS identity, with its two outward calls answered locally: the credential
 * provider, and the STS round trip `whoami` makes. Both are seams
 * `resolveIdentity` already offers, so what runs is the real mapping from an STS
 * answer to a `Caller` rather than a stand-in for it.
 */
const onAws = ({ expiration = null, caller = {} }: { expiration?: Date | null; caller?: Record<string, string> } = {}) =>
  resolveIdentity({
    scope: scope({ home: 'aws', region: 'ap-southeast-1' }),
    createSts: () => ({ send: async () => caller }),
    credentialsFor: () =>
      (async () => ({
        accessKeyId: 'ASIA',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        ...(expiration ? { expiration } : {}),
      })) as any,
  })

const record = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

/** Captures what the child would have been started with, and exits cleanly. */
const spawned = () => {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const spawnProcess = (command: string, args: string[], options: any) => {
    calls.push({ command, args, env: options.env })
    return {
      on(event: string, handler: (code: number) => void) {
        if (event === 'close') queueMicrotask(() => handler(0))
        return this
      },
    }
  }
  return { calls, spawnProcess }
}

test('exec hands the child what the resolved cloud says an identity is', async () => {
  // The break this covers: the handler built the child environment itself, from
  // an AWS key triple, so a GCP stage failed with `identity.credentials is not a
  // function` before the child was ever started.
  const child = spawned()
  const { log } = record()
  const code = await exec({
    identity: onGcp({ client_email: 'deploy@boxlite-dev.iam.gserviceaccount.com' }),
    inner: ['echo', 'hi'],
    log,
    spawnProcess: child.spawnProcess,
  })

  assert.equal(code, 0)
  assert.equal(child.calls.length, 1)
  const { env } = child.calls[0]!
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'boxlite-dev')
  // gcloud and the Pulumi provider read this one rather than the above.
  assert.equal(env.CLOUDSDK_CORE_PROJECT, 'boxlite-dev')
  assert.equal(env.CLOUDSDK_COMPUTE_REGION, 'asia-southeast1')
  // The ambient AWS identity is cleared rather than carried, which is the whole
  // point of letting the identity build the environment rather than the command.
  for (const name of ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    assert.equal(env[name], undefined, `${name} reached a child running as the other cloud`)
  }
  // Cleared, not emptied: everything else the shell had is still there.
  assert.equal(env.PATH, '/usr/bin')
})

test('exec on AWS still hands the child the triple, and warns about the deadline', async () => {
  const expiration = new Date('2026-01-01T00:00:00Z')
  const child = spawned()
  const printed = record()
  await exec({
    identity: onAws({ expiration }),
    inner: ['echo', 'hi'],
    log: printed.log,
    spawnProcess: child.spawnProcess,
  })

  const { env } = child.calls[0]!
  assert.equal(env.AWS_ACCESS_KEY_ID, 'ASIA')
  assert.equal(env.AWS_SESSION_TOKEN, 'token')
  assert.equal(env.AWS_REGION, 'ap-southeast-1')
  assert.match(printed.lines.join('\n'), /credentials expire at 2026-01-01T00:00:00\.000Z/)
})

test('whoami names what this cloud calls a tenant, and never the other cloud’s word for it', async () => {
  const printed = record()
  await whoami({
    scope: scope(),
    identity: onGcp({ client_email: 'deploy@boxlite-dev.iam.gserviceaccount.com' }),
    log: printed.log,
  })
  const output = printed.lines.join('\n')

  assert.match(output, /^project: *boxlite-dev$/m)
  assert.match(output, /^principal: *deploy@boxlite-dev\.iam\.gserviceaccount\.com$/m)
  // An account and an ARN are AWS's words. A project reported under them is a
  // reader being told the wrong thing about which cloud they are looking at.
  assert.doesNotMatch(output, /^account:/m)
  assert.doesNotMatch(output, /^arn:/m)
  // Application default credentials refresh themselves; "long-lived" is the
  // other cloud's reason for having no deadline.
  assert.match(output, /^expires: *never \(these credentials refresh themselves\)$/m)
})

test('whoami says a principal is absent rather than printing undefined', async () => {
  // Application default credentials carry no `client_email`, so this is what a
  // person signed in with `gcloud auth application-default login` sees.
  const printed = record()
  await whoami({ scope: scope(), identity: onGcp(), log: printed.log })
  const output = printed.lines.join('\n')

  assert.doesNotMatch(output, /undefined/)
  assert.match(output, /^principal: *\(none; these credentials name no principal\)$/m)
})

test('whoami on AWS reports an account and an ARN, exactly as before', async () => {
  const printed = record()
  await whoami({
    scope: scope({ home: 'aws', region: 'ap-southeast-1' }),
    identity: onAws({ caller: { Account: '000000000000', Arn: 'arn:aws:iam::000000000000:user/xinyu' } }),
    log: printed.log,
  })
  const output = printed.lines.join('\n')

  assert.match(output, /^account: *000000000000$/m)
  assert.match(output, /^arn: *arn:aws:iam::000000000000:user\/xinyu$/m)
  assert.match(output, /^expires: *never \(long-lived credentials\)$/m)
})

test('an identity from a cloud this command has no words for is refused, not guessed at', async () => {
  // `resolveHome` refuses an unknown home before one could reach here. This is
  // the same refusal one layer down, so the answer to a third cloud is a message
  // naming it rather than a project printed under some neutral heading.
  const printed = record()
  await assert.rejects(
    () =>
      whoami({
        scope: scope(),
        identity: { ...onGcp(), home: 'azure' } as any,
        log: printed.log,
      }),
    /Unknown home "azure"/,
  )
})
