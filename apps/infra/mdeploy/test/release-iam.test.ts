import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReleaseResourceNotFound, verifyReleaseIam } from '../src/release-iam.ts'
import { runReleasePreDeploy, verifyReleaseApi } from '../src/release-migrations.ts'
import { run } from '../src/run.ts'

const project = 'boxlite-test-project'
const scope = { stage: 'release-test', project, region: 'us-central1', home: 'gcp' } as const
const account = (name: string) => `${name}@${project}.iam.gserviceaccount.com`
const deployer = account('ci')
const declaration = {
  stage: scope.stage,
  project,
  job: 'schema-job',
  service: 'api',
  instance: 'postgres',
  ownerAccount: account('migration'),
  apiAccount: account('api'),
  ordinaryAccounts: [account('other-stage'), account('legacy')],
  ownerSecret: 'schema-owner',
  ownerSecretVersion: '2',
  image: `us-docker.pkg.dev/${project}/boxlite/api@sha256:${'a'.repeat(64)}`,
}
const jobResource = `//run.googleapis.com/projects/${project}/locations/${scope.region}/jobs/${declaration.job}`
const jobUrl = `https://run.googleapis.com/v2/projects/${project}/locations/${scope.region}/jobs/${declaration.job}`
const lookupUrl = 'https://policytroubleshooter.googleapis.com/v3beta/iam:troubleshoot'
const serviceUrl = `https://run.googleapis.com/v2/projects/${project}/locations/${scope.region}/services/api`
const connectionName = `${project}:${scope.region}:${declaration.instance}`
const databaseEnv = [
  { name: 'DB_DATABASE', value: 'boxlite' },
  { name: 'DB_HOST', value: `/cloudsql/${connectionName}` },
]
const migrationLogin = 'schema_owner'
const servingLogin = 'api_runtime'
const initialProvisioning = {
  database: 'boxlite',
  application: servingLogin,
  receipt: 'e'.repeat(32),
  subnetwork: 'private-job',
}
const preparedDeclaration = JSON.stringify({ ...declaration, initialProvisioning })
const subnetPath = `projects/${project}/regions/${scope.region}/subnetworks/${initialProvisioning.subnetwork}`
const privateNetwork = `projects/${project}/global/networks/private-network`
const expectedMigrations = JSON.stringify({
  baseline: ['Baseline1780000000000'],
  'pre-deploy': ['Expand1790000000000'],
  'post-deploy': [],
})
type Tuple = { principal: string; fullResourceName: string; permission: string }

function migrationProvider(
  read: ReturnType<typeof provider>['lookup'],
  options: {
    succeededCount?: number | ((args: string[]) => number)
    executionArgs?: string[]
    beforeCreate?: (args: string[], jobId: string) => void
    afterCreate?: (args: string[], jobId: string) => void
  } = {},
) {
  type Create = {
    startExecutionToken: string
    template: { taskCount: number; parallelism: number; template: { containers: [{ args: string[]; env: object[] }] } }
  }
  const collection = jobUrl.slice(0, jobUrl.lastIndexOf('/'))
  const resources = new Map<string, object>()
  const creates: Array<{ id: string; specification: Create }> = []
  return {
    creates,
    async lookup<T>({ url, data }: { url: string; data?: object }): Promise<T> {
      const createPrefix = `${collection}?jobId=`
      if (url.startsWith(createPrefix)) {
        const id = url.slice(createPrefix.length)
        const specification = data as Create
        const args = specification.template.template.containers[0].args
        options.beforeCreate?.(args, id)
        const job = `${collection}/${id}`
        assert.ok(!resources.has(job), 'the same immutable Job was created twice')
        const execution = `${job}/executions/${id}-${specification.startExecutionToken}`
        const resourceName = (address: string) => address.replace('https://run.googleapis.com/v2/', '')
        creates.push({ id, specification })
        resources.set(job, {
          name: resourceName(job),
          template: specification.template,
          latestCreatedExecution: { name: resourceName(execution) },
          executionCount: 1,
        })
        const task = specification.template.template
        resources.set(execution, {
          name: resourceName(execution),
          taskCount: 1,
          succeededCount:
            typeof options.succeededCount === 'function' ? options.succeededCount(args) : (options.succeededCount ?? 1),
          completionTime: '2026-11-26T04:00:00Z',
          template: { ...task, containers: [{ ...task.containers[0], args: options.executionArgs ?? args }] },
        })
        options.afterCreate?.(args, id)
        return {} as T
      }
      if (url.startsWith(`${collection}/release-migrate-`)) {
        const resource = resources.get(url)
        if (!resource) throw new ReleaseResourceNotFound('No migration Job or execution')
        return resource as T
      }
      return read<T>({ url, data })
    },
  }
}

function provider(
  changed: {
    image?: string
    apiAccount?: string
    decision?: (check: Tuple) => string | undefined
    serviceError?: Error
    subnet?: string
    receipt?: string
    instanceNetwork?: string
  } = {},
) {
  const checked: Tuple[] = []
  return {
    checked,
    async lookup<T>({ url, data }: { url: string; data?: object }): Promise<T> {
      if (url === jobUrl) {
        assert.equal(data, undefined)
        return {
          etag: 'test-job-etag',
          template: {
            template: {
              serviceAccount: declaration.ownerAccount,
              vpcAccess: {
                egress: 'PRIVATE_RANGES_ONLY',
                networkInterfaces: [{ subnetwork: changed.subnet ?? initialProvisioning.subnetwork }],
              },
              volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: [connectionName] } }],
              containers: [
                {
                  name: 'migration',
                  command: ['node'],
                  volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
                  image: changed.image ?? declaration.image,
                  env: [
                    ...databaseEnv,
                    { name: 'DB_USERNAME', value: migrationLogin },
                    {
                      name: 'DB_PASSWORD',
                      valueSource: {
                        secretKeyRef: {
                          secret: `projects/${project}/secrets/${declaration.ownerSecret}`,
                          version: declaration.ownerSecretVersion,
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        } as T
      }
      if (url === serviceUrl) {
        assert.equal(data, undefined)
        if (changed.serviceError) throw changed.serviceError
        return { template: { serviceAccount: changed.apiAccount ?? declaration.apiAccount } } as T
      }
      if (url === `https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}/instances/${declaration.instance}`) {
        return {
          name: declaration.instance,
          connectionName,
          state: 'RUNNABLE',
          ipAddresses: [{ type: 'PRIVATE' }],
          settings: {
            userLabels: { boxlite_release_bootstrap: changed.receipt ?? initialProvisioning.receipt },
            ipConfiguration: {
              ipv4Enabled: false,
              enablePrivatePathForGoogleCloudServices: true,
              privateNetwork: changed.instanceNetwork ?? privateNetwork,
            },
          },
        } as T
      }
      if (url === `https://compute.googleapis.com/compute/v1/${subnetPath}`) {
        return { network: `https://www.googleapis.com/compute/v1/${privateNetwork}` } as T
      }
      assert.equal(url, lookupUrl)
      const { accessTuple } = data as { accessTuple: Tuple }
      checked.push(accessTuple)
      const positive = [deployer, declaration.ownerAccount].includes(accessTuple.principal)
      return { overallAccessState: changed.decision?.(accessTuple) ?? (positive ? 'CAN_ACCESS' : 'CANNOT_ACCESS') } as T
    },
  }
}

test('release IAM proof checks live Job and serving identity and separates owner execution from ordinary deployment', async () => {
  const cloud = provider()
  assert.equal(await verifyReleaseIam(JSON.stringify(declaration), scope, deployer, cloud.lookup), cloud.checked.length)
  for (const principal of [...declaration.ordinaryAccounts, declaration.apiAccount]) {
    assert.ok(
      cloud.checked.some(
        (check) =>
          check.principal === principal &&
          check.fullResourceName === jobResource &&
          check.permission === 'run.jobs.runWithOverrides',
      ),
    )
    assert.ok(
      cloud.checked.some((check) => check.principal === principal && check.permission === 'cloudsql.users.update'),
    )
    assert.ok(
      cloud.checked.some(
        (check) => check.principal === principal && check.permission === 'resourcemanager.projects.setIamPolicy',
      ),
    )
  }
  for (const permission of ['run.jobs.create', 'run.jobs.get', 'run.executions.get']) {
    assert.ok(cloud.checked.some((check) => check.principal === deployer && check.permission === permission))
  }
})

test('initial release IAM can check a prepared private database before a serving API exists', async () => {
  const serviceError = new ReleaseResourceNotFound('No service')
  const cloud = provider({ serviceError })
  assert.equal(await verifyReleaseIam(preparedDeclaration, scope, deployer, cloud.lookup), cloud.checked.length)
  assert.ok(cloud.checked.length > 0)
  await assert.rejects(verifyReleaseIam(JSON.stringify(declaration), scope, deployer, cloud.lookup), /No service/)
  for (const [changed, failure] of [
    [{ serviceError: new Error('Permission denied') }, /Permission denied/],
    [{ serviceError, receipt: 'f'.repeat(32) }, /recorded bootstrap receipt/],
    [{ serviceError, subnet: 'other-subnet' }, /declared private VPC subnet/],
    [{ serviceError, instanceNetwork: `projects/${project}/global/networks/wrong` }, /private database network/],
  ] as const) {
    const refused = provider(changed)
    await assert.rejects(verifyReleaseIam(preparedDeclaration, scope, deployer, refused.lookup), failure)
    assert.equal(refused.checked.length, 0)
  }
})

test('release IAM proof rejects an ordinary inherited grant, unknown effective permission, or missing positive control', async () => {
  for (const [principal, permission, state] of [
    [declaration.ordinaryAccounts[1], 'run.jobs.runWithOverrides', 'CAN_ACCESS'],
    [declaration.apiAccount, 'secretmanager.versions.access', 'UNKNOWN_INFO'],
    [deployer, 'run.jobs.create', 'CANNOT_ACCESS'],
    [deployer, 'run.executions.get', 'CANNOT_ACCESS'],
  ]) {
    const cloud = provider({
      decision: (check) => (check.principal === principal && check.permission === permission ? state : undefined),
    })
    await assert.rejects(
      verifyReleaseIam(JSON.stringify(declaration), scope, deployer, cloud.lookup),
      /Release IAM proof failed/,
    )
  }
})

test('release IAM proof rejects a changed image, changed API account, or cross-stage evidence before evaluating grants', async () => {
  for (const [cloud, input, expected] of [
    [provider({ image: `${declaration.image.slice(0, -1)}b` }), declaration, /Live migration Job/],
    [provider({ apiAccount: declaration.ownerAccount }), declaration, /Live API service account/],
    [provider(), { ...declaration, stage: 'other' }, /another stage/],
  ] as const) {
    await assert.rejects(verifyReleaseIam(JSON.stringify(input), scope, deployer, cloud.lookup), expected)
    assert.equal(cloud.checked.length, 0)
  }
})

test('the configured GCP_DEPLOYER is required and remains the release caller in an isolated project', async () => {
  const cloud = provider()
  const isolated = JSON.stringify({ ...declaration, ordinaryAccounts: [] })
  await assert.rejects(verifyReleaseIam(isolated, scope, undefined, cloud.lookup), /GCP_DEPLOYER/)
  assert.equal(cloud.checked.length, 0)
  await verifyReleaseIam(isolated, scope, deployer, cloud.lookup)
  assert.ok(cloud.checked.some((check) => check.principal === deployer && check.permission === 'run.jobs.create'))
  assert.ok(
    cloud.checked.some((check) => check.principal === declaration.apiAccount && check.permission === 'run.jobs.run'),
  )
})

const releaseInvocation = { scope, deployer, runId: '72930', runAttempt: '1', log: () => undefined }

test('release API readback requires the selected revision on normal traffic and tagged routes', async () => {
  const ready = 'api-ready'
  const revision = `${serviceUrl.slice('https://run.googleapis.com/v2/'.length)}/revisions/${ready}`
  const candidate = {
    database: 'boxlite',
    application: servingLogin,
    service: declaration.service,
    account: declaration.apiAccount,
    instance: declaration.instance,
  }
  const normalTraffic = [{ revision, percent: 100 }]
  const liveEnv = [
    ...databaseEnv,
    { name: 'DB_USERNAME', value: servingLogin },
    { name: 'RUN_MIGRATIONS', value: 'false' },
  ]
  const readback = ({ traffic = normalTraffic, image = declaration.image, env = liveEnv } = {}) =>
    verifyReleaseApi(JSON.stringify(declaration), scope, deployer, candidate, async <T>({ url }: { url: string }) => {
      if (url === serviceUrl) return { latestReadyRevision: ready, trafficStatuses: traffic } as T
      assert.equal(url, `${serviceUrl}/revisions/${ready}`)
      return { serviceAccount: candidate.account, containers: [{ image, env }] } as T
    })

  await readback()
  await assert.rejects(readback({ traffic: [] }), /all API traffic and tagged routes/)
  await assert.rejects(
    readback({ traffic: [...normalTraffic, { revision: 'api-old', percent: 0 }] }),
    /all API traffic and tagged routes/,
  )
  await assert.rejects(readback({ image: declaration.image.replace(/a$/, 'b') }), /does not match the selected image/)
  await assert.rejects(
    readback({
      env: liveEnv.map((entry) => (entry.name === 'DB_USERNAME' ? { ...entry, value: migrationLogin } : entry)),
    }),
    /does not match the selected image, identity, or database/,
  )
})

test('the existing-stage expansion runs the pinned Job, verifies the journal, and refuses unsafe predecessors', async () => {
  const expected = expectedMigrations
  const input = {
    ...releaseInvocation,
    declaration: JSON.stringify(declaration),
    expected,
    readCandidate: () => initialCandidate,
  }
  const version = (runMigrations: string) => ({
    containers: [
      {
        env: [
          ...databaseEnv,
          { name: 'DB_USERNAME', value: servingLogin },
          { name: 'RUN_MIGRATIONS', value: runMigrations },
        ],
      },
    ],
  })
  const cloudFor = (options: { taggedStartup?: string; succeededCount?: number; executionArgs?: string[] } = {}) =>
    migrationProvider(async <T>({ url, data }: { url: string; data?: object }): Promise<T> => {
      if (url === serviceUrl)
        return {
          template: version('false'),
          latestReadyRevision: 'api-ready',
          trafficStatuses: [{ revision: 'api-tagged' }],
        } as T
      if (url === `${serviceUrl}/revisions/api-ready`) return version('false') as T
      if (url === `${serviceUrl}/revisions/api-tagged`) return version(options.taggedStartup ?? 'false') as T
      return provider().lookup<T>({ url, data })
    }, options)

  const unsafe = cloudFor({ taggedStartup: 'true' })
  await assert.rejects(runReleasePreDeploy(input, unsafe.lookup), /each reachable API revision/)
  assert.equal(unsafe.creates.length, 0)
  const wrongDatabase = cloudFor()
  await assert.rejects(
    runReleasePreDeploy(
      { ...input, readCandidate: () => ({ ...initialCandidate, database: 'other' }) },
      wrongDatabase.lookup,
    ),
    /rendered API database/,
  )
  assert.equal(wrongDatabase.creates.length, 0)
  const cloud = cloudFor()
  await runReleasePreDeploy(input, cloud.lookup)
  for (const { specification } of cloud.creates) {
    assert.equal(specification.template.taskCount, 1)
    assert.equal(specification.template.parallelism, 1)
    assert.match(specification.startExecutionToken, /^[a-z0-9-]+$/)
  }
  assert.deepEqual(
    cloud.creates.map(({ specification }) => {
      const { args, env } = specification.template.template.containers[0]
      return [args, env.at(-1)]
    }),
    [
      [
        ['dist/apps/api/migrate.js', 'check-database'],
        { name: 'BOXLITE_EXPECTED_DATABASE', value: JSON.stringify({ database: 'boxlite', username: migrationLogin }) },
      ],
      [
        ['dist/apps/api/migrate.js', 'run', 'pre-deploy', '--require-admission-closed'],
        { name: 'BOXLITE_EXPECTED_MIGRATIONS', value: expected },
      ],
      [['dist/apps/api/migrate.js', 'verify', 'pre-deploy'], { name: 'BOXLITE_EXPECTED_MIGRATIONS', value: expected }],
    ],
  )
  const failed = cloudFor({ succeededCount: 0 })
  await assert.rejects(runReleasePreDeploy(input, failed.lookup), /successful completion/)
  assert.equal(failed.creates.length, 1)
  const mismatched = cloudFor({ executionArgs: ['dist/apps/api/migrate.js', 'verify', 'pre-deploy'] })
  await assert.rejects(runReleasePreDeploy(input, mismatched.lookup), /successful completion/)
  assert.equal(mismatched.creates.length, 1)
})

const initialCandidate = {
  database: initialProvisioning.database,
  application: initialProvisioning.application,
  service: declaration.service,
  account: declaration.apiAccount,
  instance: declaration.instance,
}
const initialInvocation = {
  ...releaseInvocation,
  declaration: preparedDeclaration,
  expected: expectedMigrations,
  readCandidate: () => initialCandidate,
}

test('first provisioning proves prepared resources and verifies the baseline before API apply', async () => {
  const serviceError = new ReleaseResourceNotFound('No service')
  const attempts: string[][] = []
  const verify = (receipt: string, succeededCount = 1, rendered = initialCandidate) => {
    const cloud = provider({ serviceError, receipt })
    const migration = migrationProvider(cloud.lookup, { succeededCount, afterCreate: (args) => attempts.push(args) })
    return runReleasePreDeploy({ ...initialInvocation, readCandidate: () => rendered }, migration.lookup)
  }
  await assert.rejects(verify('f'.repeat(32)), /recorded bootstrap receipt/)
  await assert.rejects(
    verify(initialProvisioning.receipt, 1, { ...initialCandidate, database: 'other' }),
    /rendered API database/,
  )
  assert.equal(attempts.length, 0)
  await assert.rejects(verify(initialProvisioning.receipt, 0), /successful completion/)
  assert.deepEqual(attempts.splice(0), [['dist/apps/api/migrate.js', 'check-database']])
  assert.equal(await verify(initialProvisioning.receipt), declaration.image)
  assert.deepEqual(attempts, [
    ['dist/apps/api/migrate.js', 'check-database'],
    ['dist/apps/api/migrate.js', 'run', 'pre-deploy', '--include-baseline', '--require-first-provisioning'],
    ['dist/apps/api/migrate.js', 'verify', 'pre-deploy'],
  ])
})

for (const ready of [true, false]) {
  test(`resuming first provisioning with a ${ready ? 'ready' : 'pending'} API verifies the original migration execution`, async () => {
    let serving = false
    const cloud = provider({ serviceError: new ReleaseResourceNotFound('No service') })
    const version = {
      serviceAccount: declaration.apiAccount,
      containers: [
        {
          image: declaration.image,
          env: [
            ...databaseEnv,
            { name: 'DB_USERNAME', value: servingLogin },
            { name: 'RUN_MIGRATIONS', value: 'false' },
          ],
        },
      ],
    }
    const migration = migrationProvider(async <T>({ url, data }: { url: string; data?: object }): Promise<T> => {
      if (serving && url === serviceUrl)
        return {
          template: version,
          reconciling: !ready,
          ...(ready
            ? { latestReadyRevision: 'api-ready', trafficStatuses: [{ revision: 'api-ready', percent: 100 }] }
            : {}),
        } as T
      if (serving && url === `${serviceUrl}/revisions/api-ready`) return version as T
      return cloud.lookup<T>({ url, data })
    })
    assert.equal(await runReleasePreDeploy(initialInvocation, migration.lookup), declaration.image)
    serving = true
    assert.equal(
      await runReleasePreDeploy({ ...initialInvocation, runAttempt: '2' }, migration.lookup),
      declaration.image,
    )
    const commands = migration.creates.map(({ specification }) => specification.template.template.containers[0].args[1])
    assert.deepEqual(commands, ['check-database', 'run', 'verify', 'check-database', 'verify'])
    if (!ready) {
      await assert.rejects(
        runReleasePreDeploy({ ...initialInvocation, runId: '72931' }, migration.lookup),
        /requires a completed initial migration Job/,
      )
      assert.equal(migration.creates.at(-1)?.specification.template.template.containers[0].args[1], 'check-database')
    }
  })
}

for (const interruption of ['before acceptance', 'after acceptance'] as const) {
  test(`retrying first provisioning ${interruption} executes the migration phase once`, async () => {
    const cloud = provider({ serviceError: new ReleaseResourceNotFound('No service') })
    let interruptedJob: string | undefined
    const interrupt = (args: string[], jobId: string) => {
      if (args[1] !== 'run' || interruptedJob) return
      interruptedJob = jobId
      throw new Error('Interrupted migration submission')
    }
    const migration = migrationProvider(
      cloud.lookup,
      interruption === 'before acceptance' ? { beforeCreate: interrupt } : { afterCreate: interrupt },
    )

    await assert.rejects(runReleasePreDeploy(initialInvocation, migration.lookup), /Interrupted migration submission/)
    assert.equal(
      await runReleasePreDeploy({ ...initialInvocation, runAttempt: '2' }, migration.lookup),
      declaration.image,
    )
    const writes = migration.creates.filter(
      ({ specification }) => specification.template.template.containers[0].args[1] === 'run',
    )
    assert.deepEqual(
      writes.map(({ id }) => id),
      [interruptedJob],
    )
  })
}

test('a later attempt starts a new migration Job after a verified terminal failure', async () => {
  const cloud = provider({ serviceError: new ReleaseResourceNotFound('No service') })
  let submittedMigrations = 0
  const migration = migrationProvider(cloud.lookup, {
    succeededCount: (args) => (args[1] === 'run' && ++submittedMigrations === 1 ? 0 : 1),
  })
  await assert.rejects(runReleasePreDeploy(initialInvocation, migration.lookup), /successful completion/)
  await assert.rejects(runReleasePreDeploy(initialInvocation, migration.lookup), /successful completion/)
  assert.equal(submittedMigrations, 1)
  assert.equal(
    await runReleasePreDeploy({ ...initialInvocation, runAttempt: '2' }, migration.lookup),
    declaration.image,
  )
  assert.equal(submittedMigrations, 2)
})

test('mdeploy runs release IAM verification without initializing deployment or reading stage secrets', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-release-iam-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, '.mstage.config.json')
  const sample = JSON.parse(readFileSync(new URL('../../.mstage.config.example.json', import.meta.url), 'utf8'))
  const stage = { ...sample.stages.dev2, project, region: scope.region }
  writeFileSync(path, JSON.stringify({ ...sample, stages: { [scope.stage]: stage } }))
  const cloud = provider()
  const input = {
    argv: ['--stage', scope.stage, '--check-release-iam'],
    environment: { MSTAGE_CONFIG: path, BOXLITE_RELEASE_IAM: JSON.stringify(declaration), GCP_DEPLOYER: deployer },
    cwd: new URL('../..', import.meta.url).pathname,
    checkLogin: async () => assert.fail('Unexpected deployment sign-in'),
    targetWith: async () => assert.fail('Unexpected deployment engine'),
    fetchEnv: async () => assert.fail('Unexpected stage secret read'),
    log: () => undefined,
  }
  assert.equal(
    await run({
      ...input,
      checkReleaseIam: (raw, actual, configuredDeployer) =>
        verifyReleaseIam(raw, actual, configuredDeployer, cloud.lookup),
    }),
    0,
  )
  assert.ok(cloud.checked.length > 0)
  await assert.rejects(run({ ...input, argv: [...input.argv, '--remove'] }), /runs by itself/)
})
