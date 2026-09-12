/*
 * The out-of-band roll, and the one thing it can do that a deploy cannot.
 *
 * What is worth pinning is the boundary: this tool shares the payload, the
 * transports and the sequencing with the deploy, and differs in exactly two
 * ways — it discovers the fleet itself, and it can pass `allowDowngrade`. A
 * second, laxer implementation of the upgrade is the failure this guards
 * against, so the assertions are mostly about what it does *not* re-decide.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { RunnerUpdateError, compareHostsIn, updateRunners, type Host } from '../src/runner-update.ts'
import type { CommandResult, RunCommand } from '../src/upgrade-runners.ts'

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })

/**
 * The committed example, not this machine's stage file.
 *
 * These drive the real `--stage` resolution, so the stages they name have to be
 * declared somewhere — and `.mstage.config.json` is not committed, so on a
 * runner there is nothing to declare them. Reading the example also keeps it
 * from going stale: a stage dropped from it fails here.
 */
const EXAMPLE = fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url))

/** A fleet of two on AWS, and an SSM command that succeeds. */
const awsFleet = (calls: string[][] = []): RunCommand => {
  return (file, args) => {
    calls.push([file, ...args])
    if (args[1] === 'describe-instances') {
      return ok('i-0002\tboxlite-app-dev-runner-2\ni-0001\tboxlite-app-dev-runner')
    }
    if (args[1] === 'send-command') return ok('cmd-1')
    if (args.includes('Status')) return ok('Success')
    return ok('')
  }
}

const gcpFleet = (calls: string[][] = []): RunCommand => {
  return (file, args) => {
    calls.push([file, ...args])
    if (args[1] === 'instances') return ok('boxlite-app-dev2-runner\nboxlite-app-dev2-runner-2')
    return ok('new identity: 0.10.0')
  }
}

const drive = (argv: string[], run: RunCommand, home: 'aws' | 'gcp' = 'aws') =>
  updateRunners({
    argv,
    environment: { MSTAGE_CONFIG: EXAMPLE },
    cwd: new URL('../..', import.meta.url).pathname,
    log: () => {},
    checkLogin: async () => 0,
    resolveHomeWith: (async () => ({
      identity: { home, childEnvironment: async () => ({ env: {}, expiresAt: null }) },
      backend: {},
    })) as never,
    run,
    sleep: () => {},
  })

test('a fleet is discovered and visited in a stable order, one host at a time', async () => {
  // describe-instances promises no order, so a roll that took it as given would
  // visit the fleet differently every run — and the whole point of going one at
  // a time is that a failure leaves a known set still serving.
  const calls: string[][] = []
  assert.equal(await drive(['--stage', 'dev'], awsFleet(calls)), 0)
  const sent = calls.filter((call) => call[2] === 'send-command')
  assert.equal(sent.length, 2, 'both hosts were rolled')
  const targets = sent.map((call) => call[call.indexOf('--instance-ids') + 1])
  assert.deepEqual(targets, ['i-0001', 'i-0002'], 'sorted by the name a console shows, not by the API’s order')
})

test('the fleet’s order is its own, not the string order of its names', () => {
  // The case a two-host fixture cannot show: `stack-env.ts` names hosts
  // `-default`, `-2`, `-3`… so sorting by string puts `-10` before `-2` and
  // both before `-default`. A roll has to walk the order the deploy's chain
  // walks, or "which hosts are still serving" means something different after a
  // failure than it did before.
  const PREFIX = 'boxlite-app-dev-runner'
  // The first host takes the bare prefix; the rest a number.
  const host = (label: string): Host => ({
    target: `i-${label}`,
    label: label === 'default' ? PREFIX : `${PREFIX}-${label}`,
  })
  const fleet = [host('10'), host('2'), host('default'), host('3')]
  assert.deepEqual(
    [...fleet].sort(compareHostsIn(PREFIX)).map((entry) => entry.label),
    [PREFIX, `${PREFIX}-2`, `${PREFIX}-3`, `${PREFIX}-10`],
  )

  // A host neither pattern explains goes last rather than jumping the queue: it
  // was renamed by hand, or belongs to something else entirely.
  const stranger = { target: 'i-x', label: 'someone-elses-box' }
  assert.deepEqual(
    [stranger, host('2'), host('default')].sort(compareHostsIn(PREFIX)).map((entry) => entry.label),
    [PREFIX, `${PREFIX}-2`, 'someone-elses-box'],
  )
})

test('the version is the checkout’s unless one is named, and it is always a release', async () => {
  // A build is addressed by a commit and staged per stage; installing one is
  // what deploying that commit does. A rollback names a published version.
  const calls: string[][] = []
  await drive(['--stage', 'dev', '--version', '0.9.5'], awsFleet(calls))
  const comment = calls.find((call) => call[2] === 'send-command')?.join(' ')
  assert.match(comment ?? '', /boxlite-runner upgrade to 0\.9\.5/)

  const fromCheckout: string[][] = []
  await drive(['--stage', 'dev'], awsFleet(fromCheckout))
  const withoutVersion = fromCheckout.find((call) => call[2] === 'send-command')?.join(' ')
  assert.match(withoutVersion ?? '', /boxlite-runner upgrade to \d+\.\d+\.\d+/)
  assert.doesNotMatch(withoutVersion ?? '', /\+[0-9a-f]{40}/, 'never a build identity')
})

test('the downgrade force reaches the payload only when it is asked for', async () => {
  // The whole reason this tool exists: the deploy path cannot set this, so a
  // stage cannot be left in a state where downgrades are quietly permitted.
  const decode = (calls: string[][]): string => {
    const parameters = calls.find((call) => call[2] === 'send-command')?.find((argument) => argument.startsWith('commands='))
    const encoded = parameters?.match(/echo ([A-Za-z0-9+/=]+) \|/)?.[1] as string
    return Buffer.from(encoded, 'base64').toString('utf8')
  }

  const guarded: string[][] = []
  await drive(['--stage', 'dev'], awsFleet(guarded))
  assert.match(decode(guarded), /ALLOW_DOWNGRADE=""/)

  const forced: string[][] = []
  await drive(['--stage', 'dev', '--allow-downgrade'], awsFleet(forced))
  assert.match(decode(forced), /ALLOW_DOWNGRADE="1"/)
  // And it is the same script either way — the converge, the verification and
  // the rollback are not re-decided here.
  assert.match(decode(forced), /already serving \$TARGET; leaving the unit untouched/)
  assert.match(decode(forced), /upgrade failed; rolling back/)
})

test('a named host has to be one that is running, rather than silently matching nothing', async () => {
  await assert.rejects(
    () => drive(['--stage', 'dev', '--host', 'boxlite-app-dev-runner-9'], awsFleet()),
    (error: Error) => {
      assert.ok(error instanceof RunnerUpdateError)
      assert.match(error.message, /boxlite-app-dev-runner-9 is not a running runner in this stage/)
      assert.match(error.message, /Found: boxlite-app-dev-runner, boxlite-app-dev-runner-2/)
      return true
    },
  )
})

test('naming one host rolls that one and no other', async () => {
  const calls: string[][] = []
  await drive(['--stage', 'dev', '--host', 'boxlite-app-dev-runner-2'], awsFleet(calls))
  const sent = calls.filter((call) => call[2] === 'send-command')
  assert.equal(sent.length, 1)
  assert.ok(sent[0]?.includes('i-0002'))
})

test('a protected stage is confirmed, exactly as a deploy of it would be', async () => {
  // This restarts every runner in the fleet, and boxes on a host take the
  // restart. The gate is the same one `mdeploy` applies for the same reason.
  await assert.rejects(
    () => drive(['--stage', 'prod'], awsFleet()),
    /Stage "prod" is protected in .*Add --confirm to roll its fleet/s,
  )
  assert.equal(await drive(['--stage', 'prod', '--confirm'], awsFleet()), 0)
})

test('an empty fleet is a refusal, not a silent success', async () => {
  const empty: RunCommand = (_file, args) => (args[1] === 'describe-instances' ? ok('') : ok(''))
  await assert.rejects(() => drive(['--stage', 'dev'], empty), /no running runner in boxlite-app\/dev/)
})

test('on GCP the fleet is listed by name and reached through the tunnel', async () => {
  // The same two questions, answered with this cloud's own vocabulary: an
  // instance name rather than an id, and IAP rather than SSM.
  const calls: string[][] = []
  assert.equal(await drive(['--stage', 'dev2'], gcpFleet(calls), 'gcp'), 0)
  const listed = calls.find((call) => call[2] === 'instances')
  assert.ok(listed?.some((argument) => argument.startsWith('--filter=name~^boxlite-app-dev2-runner')))
  const sessions = calls.filter((call) => call[2] === 'ssh')
  assert.equal(sessions.length, 2)
  assert.ok(sessions[0]?.includes('--tunnel-through-iap'))
  assert.ok(sessions[0]?.includes('boxlite-app-dev2-runner'))
})

test('a stage is required, and mstage says which ones there are', async () => {
  // Refused by `resolveScope` rather than by a check here: it already names the
  // stages the config declares, which is what someone who mistyped one needs.
  await assert.rejects(() => drive([], awsFleet()), /--stage is required\..*declares: dev, prod, dev2/s)
})
