/*
 * The one dispatch: which cloud this stage lives in, and what serves it.
 *
 * Driven without either cloud by injecting `resolveHomeWith`, which is what
 * `resolveDeployTarget` takes it for. What is checked is that the switch is
 * exhaustive, that each engine is handed the identity it can actually use, and
 * that the group list is the target's answer rather than the caller's — because
 * those are the four things that used to be separate `=== 'gcp'` checks and had
 * to agree.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDeployTarget } from '../src/deploy.ts'
import { pulumiDeploy } from '../src/pulumi.ts'
import { DnsAuthorizationError } from '../src/dns-authorization.ts'
import { DEPLOY_GROUP, PULUMI_GROUP, SERVICE_GROUPS } from '../src/env.ts'
import { REQUIRED_CREDENTIAL_SECONDS, REQUIRED_PREVIEW_SECONDS, windowFor } from '../src/credential-window.ts'

const config = { root: '/repo/apps/infra', path: '/repo/apps/infra/mstage.config.json' }
const scope = (overrides: Record<string, unknown> = {}) =>
  ({
    stage: 'dev',
    app: 'boxlite',
    region: 'ap-southeast-1',
    home: 'aws',
    project: null,
    protect: false,
    roleArn: null,
    roleArnSource: null,
    roleSessionName: null,
    regionSource: 'test',
    ...overrides,
  }) as any

const identity = (home: string) => ({
  home,
  region: 'ap-southeast-1',
  stage: 'dev',
  app: 'boxlite',
  credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c', expiration: undefined }),
  whoami: async () => ({}),
  expiresAt: async () => null,
  assertUsableFor: async () => {},
  childEnvironment: async () => ({ env: {}, expiresAt: null }),
})

const home = (cloud: 'aws' | 'gcp') => async () => ({
  identity: identity(cloud),
  backend: { home: cloud } as any,
  stateBucket: async () => 'boxlite-state',
})

test('each cloud is answered by its own engine, and by nothing else', async () => {
  const aws = await resolveDeployTarget({ config, scope: scope(), resolveHomeWith: home('aws') as any })
  assert.equal(aws.cloud, 'aws')
  assert.equal(aws.engine, 'sst')

  const gcp = await resolveDeployTarget({
    config,
    scope: scope({ home: 'gcp', project: 'boxlite-gcp-dev' }),
    resolveHomeWith: home('gcp') as any,
  })
  assert.equal(gcp.cloud, 'gcp')
  assert.equal(gcp.engine, 'pulumi')
})

test('the store the target carries is the one that stage’s cloud answered with', async () => {
  // Carried rather than resolved again by the caller: the store, the identity,
  // the engine and the state all differ per cloud, and as four separate checks
  // they were four call sites that had to agree.
  const target = await resolveDeployTarget({
    config,
    scope: scope({ home: 'gcp', project: 'boxlite-gcp-dev' }),
    resolveHomeWith: home('gcp') as any,
  })
  assert.equal(target.backend.home, 'gcp')
})

test('a rollout reads every service’s group; a teardown reads none of them', async () => {
  // A destroyed stage has no service to configure, so asking for a service
  // group would make a half-configured stage unremovable — the one state most
  // likely to need removing.
  const declaration = { envSelectGroup: { deploy: [], api: [], proxy: [] } }
  const target = await resolveDeployTarget({ config, scope: scope(), resolveHomeWith: home('aws') as any })
  const rollout = target.environmentGroups('deploy', declaration as any)
  for (const group of [DEPLOY_GROUP, ...SERVICE_GROUPS]) assert.ok(rollout.includes(group), `${group} is not read`)
  assert.deepEqual(target.environmentGroups('remove', declaration as any), [DEPLOY_GROUP])
})

test('only the Pulumi engine asks for the passphrase, and it asks on a teardown too', async () => {
  // SST discovers its state bucket from a parameter and seals nothing with a
  // passphrase, so there is no engine group to add there. A teardown still has
  // to open the state to destroy what it describes.
  const declaration = { envSelectGroup: { deploy: [], api: [] } }
  const aws = await resolveDeployTarget({ config, scope: scope(), resolveHomeWith: home('aws') as any })
  assert.ok(!aws.environmentGroups('deploy', declaration as any).includes(PULUMI_GROUP))

  const gcp = await resolveDeployTarget({
    config,
    scope: scope({ home: 'gcp', project: 'boxlite-gcp-dev' }),
    resolveHomeWith: home('gcp') as any,
  })
  assert.ok(gcp.environmentGroups('deploy', declaration as any).includes(PULUMI_GROUP))
  assert.ok(gcp.environmentGroups('remove', declaration as any).includes(PULUMI_GROUP))
})

test('a preview does not need the window a rollout does', () => {
  // A preview holds no lock and changes nothing, so refusing to *look* because
  // a session expires in ten minutes would refuse the cheapest thing there is.
  assert.equal(windowFor('diff'), REQUIRED_PREVIEW_SECONDS)
  assert.equal(windowFor('deploy'), REQUIRED_CREDENTIAL_SECONDS)
  assert.equal(windowFor('remove'), REQUIRED_CREDENTIAL_SECONDS, 'a teardown holds the same lock as a rollout')
  // A refresh holds the lock and rewrites the state it read. It changes no
  // resource, which is why it is easy to file beside the preview and wrong to.
  assert.equal(windowFor('refresh'), REQUIRED_CREDENTIAL_SECONDS, 'a refresh writes the state a rollout writes')
})

test('a refresh reaches the engine as a refresh, not as the preview it resembles', async () => {
  /*
   * What an interrupted run leaves behind: Pulumi records an operation before
   * starting it, so a driver killed in between leaves the record and every
   * later run opens with `pending operations from previous deployment` over
   * resources it calls unknown. The engine's own advice is a refresh, and
   * before this intent existed the only way to take it was a script outside
   * this repository holding the backend URL and the passphrase by hand.
   */
  const asked: string[] = []
  await pulumiDeploy({
    intent: 'refresh',
    config: { root: '/repo/apps/infra' } as any,
    scope: scope({ home: 'gcp', project: 'boxlite-dev-project' }),
    identity: identity('gcp') as any,
    state: { bucket: 'boxlite-state' },
    stageEnvironment: { PULUMI_CONFIG_PASSPHRASE: 'passphrase' },
    log: () => {},
    lookupAuthorizations: (() => ({ ok: true, held: [] })) as any,
    createStackWith: (async () => ({
      setAllConfig: async () => {},
      up: async () => asked.push('up'),
      preview: async () => asked.push('preview'),
      destroy: async () => asked.push('destroy'),
      refresh: async () => asked.push('refresh'),
    })) as any,
  }).catch(() => {})
  assert.deepEqual(asked, ['refresh'], `the intent reached the wrong engine call: ${JSON.stringify(asked)}`)
})

/*
 * The precondition, where it is actually wired.
 *
 * `assertAuthorizationsConverge` has its own tests; what those cannot show is
 * that an apply asks it at all, and asks it before the engine is handed
 * anything. A guard that can refuse every GCP apply is worth exercising through
 * the function that calls it rather than only beside it.
 */
const applying = ({ held, intent = 'deploy' as const }: { held: { name: string; domain: string }[]; intent?: 'deploy' | 'diff' }) => {
  const started: string[] = []
  return {
    started,
    run: () =>
      pulumiDeploy({
        intent,
        config: { root: '/repo/apps/infra' } as any,
        scope: scope({ home: 'gcp', project: 'boxlite-dev-project' }),
        identity: identity('gcp') as any,
        state: { bucket: 'boxlite-state' },
        stageEnvironment: {
          PULUMI_CONFIG_PASSPHRASE: 'passphrase',
          STACK_DOMAIN: 'dev.boxlite.ai',
          PROXY_DOMAIN: 'proxy.dev.boxlite.ai',
        },
        log: () => {},
        lookupAuthorizations: () => ({ ok: true, held }),
        createStackWith: (async () => {
          started.push('engine')
          return { setAllConfig: async () => {}, up: async () => ({}) } as any
        }) as any,
      }),
  }
}

test('an apply asks what the project holds before the engine is handed anything', async () => {
  const { started, run } = applying({ held: [{ name: 'boxlite-dev-api-internal', domain: 'api.dev.boxlite.ai' }] })
  await assert.rejects(run, DnsAuthorizationError)
  assert.deepEqual(started, [], 'the engine was started before the answer came back')
})

test('a preview is not refused, because it creates nothing to be refused about', async () => {
  // A stage reads the same either way, and refusing the read would withhold the
  // plan that shows the problem.
  const { started, run } = applying({
    held: [{ name: 'boxlite-dev-api-internal', domain: 'api.dev.boxlite.ai' }],
    intent: 'diff',
  })
  await run().catch(() => {})
  assert.deepEqual(started, ['engine'], 'a preview must still reach the engine')
})

/*
 * The engine writes a spinner for a terminal — `@ updating` and a dot per tick,
 * with no newline — and a workflow log has nothing to overwrite. This driver
 * splits what it is handed into lines, so each dot arrives as a line of its
 * own: of the 1546 lines one dev apply wrote, 987 were a single `.` and 20 were
 * `@ updating....`, so 65% of the output said only that time was passing.
 *
 * What must survive is everything else, indentation included: the engine's
 * leading spaces are what separate a resource line from the diagnostic block
 * under it.
 */
test("the engine's progress spinner does not reach the log", async () => {
  const lines: string[] = []
  let emit: ((output: string) => void) | undefined
  await pulumiDeploy({
    intent: 'diff',
    config: { root: '/repo/apps/infra' } as any,
    scope: scope({ home: 'gcp', project: 'boxlite-dev-project' }),
    identity: identity('gcp') as any,
    state: { bucket: 'boxlite-state' },
    stageEnvironment: {
      PULUMI_CONFIG_PASSPHRASE: 'passphrase',
      STACK_DOMAIN: 'dev.boxlite.ai',
      PROXY_DOMAIN: 'proxy.dev.boxlite.ai',
    },
    log: (line: string) => lines.push(line),
    lookupAuthorizations: (() => ({ ok: true, held: [] })) as any,
    createStackWith: (async () => ({
      setAllConfig: async () => {},
      preview: async (options: any) => {
        emit = options.onOutput
        return {}
      },
    })) as any,
  }).catch(() => {})

  assert.ok(emit, 'the engine was never handed an output sink')
  emit('@ updating....\n')
  // Two words, which a preview writes and an apply does not: `@ updating` was
  // the whole of the first sample this was built from, and a pattern fitted to
  // it let every `@ previewing update....` through.
  emit('@ previewing update....\n')
  emit('.')
  emit('...\n')
  emit(' +  gcp:compute:Router Router created (35s)\n')
  emit('    error: 1 error occurred:\n')

  /*
   * Everything the engine wrote, named rather than filtered by the pattern
   * under test: an assertion that re-applies `PROGRESS` agrees with whatever
   * that pattern happens to miss, and the first version of it did — it passed
   * while `@ previewing update....` went straight through.
   */
  assert.deepEqual(
    lines.filter((line) => !line.startsWith('comparing every component')),
    [' +  gcp:compute:Router Router created (35s)', '    error: 1 error occurred:'],
    'only the resource line and the diagnostic survive, indentation intact',
  )
})
