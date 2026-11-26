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
import { standaloneUpdateClaimId } from '../src/protected-runner-release.ts'
import type { CommandResult, RunCommand } from '../src/upgrade-runners.ts'
import { renderPolicyScripts } from '../stack/runner-upgrade.ts'
import { RUNNER_PORT } from '../stack/runners.ts'

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
  const assignments = new Map<string, { etag: string; revisionId: string; osPolicies: unknown[] }>()
  return (file, args) => {
    calls.push([file, ...args])
    if (args[1] === 'instances') {
      return ok(
        JSON.stringify(
          ['default', 'runner-2'].map((label, index) => ({
            name: `boxlite-app-dev2-runner${index ? '-2' : ''}`,
            labels: { 'boxlite-runner': label, 'boxlite-stage': 'dev2' },
          })),
        ),
      )
    }
    if (args[2] === 'os-policy-assignments') {
      const assignment = args[4]!
      const fleet = assignment.endsWith('-fleet')
      const current = assignments.get(assignment) ?? {
        etag: 'old-etag', revisionId: 'old-revision', osPolicies: [
          { id: 'runner-binary', mode: 'ENFORCEMENT' },
          { id: 'runner-unit-env', mode: 'ENFORCEMENT' },
        ],
      }
      if (args[3] === 'update') {
        const body = JSON.parse(args.find((arg) => arg.startsWith('--request-body='))!.slice('--request-body='.length))
        if (body.etag !== current.etag) return { ok: false, status: 412, stdout: '', stderr: 'stale ETag' }
        assignments.set(assignment, { etag: 'new-etag', revisionId: 'new-revision', osPolicies: body.osPolicies })
        return ok()
      }
      return ok(
        JSON.stringify({
          name: `projects/p/locations/z/osPolicyAssignments/${assignment}`,
          ...current,
          rolloutState: 'SUCCEEDED',
          instanceFilter: {
            inclusionLabels: [
              { labels: { 'boxlite-runner': fleet ? 'runner-2' : 'default', 'boxlite-stage': 'dev2' } },
            ],
          },
          rollout: {
            disruptionBudget: fleet ? { percent: 100 } : { fixed: 1 },
            minWaitDuration: fleet ? '0s' : '300s',
          },
        }),
      )
    }
    if (args[2] === 'os-policy-assignment-reports') {
      return ok(
        JSON.stringify({
          osPolicyAssignment: `projects/p/locations/z/osPolicyAssignments/${args[4]}@new-revision`,
          osPolicyCompliances: [
            { osPolicyId: 'runner-binary', complianceState: 'COMPLIANT' },
            { osPolicyId: 'runner-unit-env', complianceState: 'COMPLIANT' },
          ],
        }),
      )
    }
    return ok('new identity: 0.10.0')
  }
}

type ClaimUpdate = NonNullable<Parameters<typeof updateRunners>[0]['claimGcpUpdate']>

const drive = (
  argv: string[],
  run: RunCommand,
  home: 'aws' | 'gcp' = 'aws',
  claimGcpUpdate: (input: Parameters<ClaimUpdate>[0]) => Promise<Pick<Awaited<ReturnType<ClaimUpdate>>, 'finish'>> =
    async () => ({ finish: async () => undefined }),
) =>
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
    requestOsConfig: async (input, options) => {
      const url = new URL(String(input))
      assert.equal(url.origin, 'https://osconfig.googleapis.com')
      assert.equal(url.searchParams.get('updateMask'), 'osPolicies')
      assert.equal(options?.method, 'PATCH')
      const reply = run('gcloud', [
        'compute', 'os-config', 'os-policy-assignments', 'update', url.pathname.split('/').at(-1)!,
        `--request-id=${url.searchParams.get('requestId')}`, `--request-body=${options?.body}`,
      ])
      if (reply.ok) return new Response(null, { status: 200 })
      if (reply.status === 412) return new Response(null, { status: 412 })
      throw new Error(reply.stderr)
    },
    sleep: () => {},
    claimGcpUpdate: async (input) => ({
      ...await claimGcpUpdate(input),
      claimId: standaloneUpdateClaimId(input.operation, ['fixture']),
      scripts: renderPolicyScripts({
        identity: input.binary.identity, binary: input.binary, port: RUNNER_PORT, allowDowngrade: input.allowDowngrade,
      }),
    }),
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
    const parameters = calls
      .find((call) => call[2] === 'send-command')
      ?.find((argument) => argument.startsWith('commands='))
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

test('on GCP the canary is verified before the remaining fleet is updated', async () => {
  const calls: string[][] = []
  assert.equal(await drive(['--stage', 'dev2'], gcpFleet(calls), 'gcp'), 0)

  const listed = calls.find((call) => call[2] === 'instances')
  assert.ok(listed?.some((argument) => argument.startsWith('--filter=name~^boxlite-app-dev2-runner')))

  const updates = calls.filter((call) => call[3] === 'os-policy-assignments' && call[4] === 'update')
  assert.deepEqual(
    updates.map((call) => call[5]),
    ['boxlite-app-dev2-runner-binary', 'boxlite-app-dev2-runner-binary-fleet'],
  )
  const report = calls.findIndex((call) => call[3] === 'os-policy-assignment-reports')
  assert.ok(report > calls.indexOf(updates[0]!) && report < calls.indexOf(updates[1]!))
  for (const update of updates) {
    const policy = JSON.parse(update.find((arg) => arg.startsWith('--request-body='))!.slice('--request-body='.length))
    assert.equal(policy.etag, 'old-etag')
    assert.deepEqual(
      policy.osPolicies.map((item: any) => item.id),
      ['runner-binary', 'runner-unit-env'],
    )
  }

  assert.ok(
    calls.some((call) => call[3] === 'os-policy-assignment-reports'),
    'the roll never waited for the agents to converge',
  )
  assert.equal(calls.filter((call) => call[2] === 'ssh').length, 0, 'the tunnel is gone from this path')
})

test('the standalone claim fences GCP policy writes and survives an ambiguous write', async () => {
  const args = ['--stage', 'dev2']
  const calls: string[][] = []
  const commands = gcpFleet(calls)
  await assert.rejects(drive(args, commands, 'gcp', async () => {
    throw new Error('controlled stage')
  }), /controlled stage/)
  assert.ok(!calls.some((call) => call[3] === 'os-policy-assignments' && call[4] === 'update'))

  let finished = false
  let retainedOperation = ''
  const interrupted: RunCommand = (file, argv) => {
    if (argv[2] === 'os-policy-assignments' && argv[3] === 'update') {
      assert.equal(commands(file, argv).ok, true, 'OS Config accepted the update before the response was lost')
      return { ok: false, status: 1, stdout: '', stderr: 'response lost' }
    }
    return commands(file, argv)
  }
  await assert.rejects(drive(args, interrupted, 'gcp', async ({ operation }) => {
    retainedOperation = operation
    return { finish: async () => { finished = true } }
  }), /response lost/)
  assert.equal(finished, false)

  calls.length = 0
  await drive([...args, '--resume-claim', retainedOperation], commands, 'gcp', async ({ operation }) => {
    assert.equal(operation, retainedOperation)
    return { finish: async () => { finished = true } }
  })
  assert.equal(finished, true)
  const resumedWrites = calls.filter((call) => call[3] === 'os-policy-assignments' && call[4] === 'update')
  assert.deepEqual(resumedWrites.map((call) => call[5]), ['boxlite-app-dev2-runner-binary-fleet'])
})

test('a delayed standalone retry cannot overwrite the enrolled policy', async () => {
  const original = gcpFleet()
  let enrollmentStarted = false
  let writesAfterEnrollment = 0
  const provider: RunCommand = (file, args) => {
    const result = original(file, args)
    if (args[2] === 'os-policy-assignments' && args[3] === 'update' && enrollmentStarted && result.ok) {
      writesAfterEnrollment++
    }
    return result
  }
  let captureOperation!: (operation: string) => void
  const capturedOperation = new Promise<string>((resolve) => { captureOperation = resolve })
  let releaseWriter!: () => void
  const writerPaused = new Promise<void>((resolve) => { releaseWriter = resolve })
  const args = ['--stage', 'dev2']
  const delayed = drive(args, provider, 'gcp', async ({ operation }) => {
    captureOperation(operation)
    await writerPaused
    return { finish: async () => {} }
  })
  const operation = await capturedOperation
  try {
    await drive([...args, '--resume-claim', operation], provider, 'gcp', async () => ({
      finish: async () => { enrollmentStarted = true },
    }))
  } finally {
    releaseWriter()
  }
  const [result] = await Promise.allSettled([delayed])
  assert.equal(writesAfterEnrollment, 0, 'the delayed retry overwrote the protected assignment')
  assert.equal(result.status, 'rejected')
  assert.match(String(result.reason), /HTTP 412/)
})

test('GCP refuses the legacy fleet-wide canary before writing either batch', async () => {
  const calls: string[][] = []
  const base = gcpFleet(calls)
  const run: RunCommand = (file, args) => {
    const result = base(file, args)
    if (args[2] === 'os-policy-assignments' && args[3] === 'describe' && !args[4]!.endsWith('-fleet')) {
      const policy = JSON.parse(result.stdout)
      policy.instanceFilter.inclusionLabels.push({ labels: { 'boxlite-runner': 'runner-2' } })
      return ok(JSON.stringify(policy))
    }
    return result
  }
  await assert.rejects(() => drive(['--stage', 'dev2'], run, 'gcp'), /mdeploy/)
  assert.equal(calls.filter((call) => call[4] === 'update').length, 0)
})

test('GCP never advances past a stale or non-compliant canary report', async () => {
  for (const stale of [true, false]) {
    const calls: string[][] = []
    const base = gcpFleet(calls)
    const run: RunCommand = (file, args) => {
      const result = base(file, args)
      if (args[2] === 'os-policy-assignment-reports' && args[3] === 'describe') {
        const report = JSON.parse(result.stdout)
        if (stale) report.osPolicyAssignment = report.osPolicyAssignment.replace('@new-revision', '@old-revision')
        else report.osPolicyCompliances[0].complianceState = 'NON_COMPLIANT'
        return ok(JSON.stringify(report))
      }
      return result
    }
    await assert.rejects(() => drive(['--stage', 'dev2'], run, 'gcp'), /did not report compliant/)
    assert.equal(calls.filter((call) => call[4] === 'update').length, 1)
  }
})

test('GCP refuses to promote another runner when the canary is stopped', async () => {
  const calls: string[][] = []
  const base = gcpFleet(calls)
  const run: RunCommand = (file, args) => {
    const result = base(file, args)
    if (args[1] !== 'instances') return result
    return ok(JSON.stringify(JSON.parse(result.stdout).slice(1)))
  }
  await assert.rejects(() => drive(['--stage', 'dev2'], run, 'gcp'), /canary.*must be running/)
  assert.equal(calls.filter((call) => call[4] === 'update').length, 0)
})

test('--host is refused on GCP, because the policy is the whole fleet', async () => {
  // Narrowing the assignment would leave it pointing at one machine after the
  // roll, which is a fleet whose other hosts are declared by nothing.
  await assert.rejects(
    () => drive(['--stage', 'dev2', '--host', 'boxlite-app-dev2-runner'], gcpFleet(), 'gcp'),
    /--host is not available on GCP/,
  )
})

test('a stage is required, and mstage says which ones there are', async () => {
  // Refused by `resolveScope` rather than by a check here: it already names the
  // stages the config declares, which is what someone who mistyped one needs.
  await assert.rejects(() => drive([], awsFleet()), /--stage is required\..*declares: dev, prod, dev2/s)
})

// A missing/wrong stage must fail before the first policy update.
test('GCP rejects unscoped or cross-stage hosts and selectors before writing', async () => {
  for (const boundary of ['host', 'policy']) {
    for (const stage of [undefined, 'dev']) {
      const calls: string[][] = []
      const base = gcpFleet(calls)
      const run: RunCommand = (file, args) => {
        const result = base(file, args)
        if (boundary === 'host' && args[1] === 'instances') {
          const hosts = JSON.parse(result.stdout)
          for (const host of hosts) host.labels['boxlite-stage'] = stage
          return ok(JSON.stringify(hosts))
        }
        if (boundary === 'policy' && args[2] === 'os-policy-assignments' && args[3] === 'describe') {
          const policy = JSON.parse(result.stdout)
          for (const entry of policy.instanceFilter.inclusionLabels) entry.labels['boxlite-stage'] = stage
          return ok(JSON.stringify(policy))
        }
        return result
      }
      await assert.rejects(() => drive(['--stage', 'dev2'], run, 'gcp'), /mdeploy/)
      assert.equal(calls.filter((call) => call[4] === 'update').length, 0)
    }
  }
})
