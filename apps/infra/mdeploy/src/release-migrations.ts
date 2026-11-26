// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyInitialReleaseDatabase } from './release-bootstrap.ts'
import {
  readReleaseMigrationJob,
  readReleaseService,
  releaseIamSettings,
  releaseLookupWithAdc,
  ReleaseResourceConflict,
  ReleaseResourceNotFound,
  type JobTemplate,
  type ReleaseLookup,
  type ReleaseScope,
} from './release-iam.ts'

export type ReleaseApiBinding = {
  database: string
  application: string
  service: string
  account: string
  instance: string
}

type ReleaseMigrationInput = {
  declaration: string | undefined
  expected: string | undefined
  scope: ReleaseScope
  deployer: string | undefined
  runId: string | undefined
  runAttempt: string | undefined
  log: (line: string) => void
  readCandidate?: () => ReleaseApiBinding
}

const RUN = 'https://run.googleapis.com/v2/'
const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MIGRATIONS = ['baseline', 'pre-deploy', 'post-deploy'] as const
const MIGRATION = /^\w+\d{13}$/
const ACTION_RUN = /^[1-9]\d*$/
const EXECUTION_TOKEN = 'phase'
const BOOTSTRAP_COMMAND = ['run', 'pre-deploy', '--include-baseline', '--require-first-provisioning']
type Container = { image?: string; args?: string[]; env?: Array<{ name?: string; value?: string }> }
type Containers = { containers?: Container[] }
type Revision = Containers & { serviceAccount?: string; reconciling?: boolean }
type Service = {
  template?: Revision
  reconciling?: boolean
  latestReadyRevision?: string
  trafficStatuses?: Array<{ revision?: string; percent?: number }>
}
type Execution = {
  name?: string
  deleteTime?: string
  completionTime?: string
  taskCount?: number
  succeededCount?: number
  template?: JobTemplate
}
type MigrationJob = {
  name?: string
  deleteTime?: string
  template?: { taskCount?: number; template?: JobTemplate }
  latestCreatedExecution?: { name?: string }
  executionCount?: number
}

function sourceManifest(raw: string | undefined): string {
  let parsed: Record<string, unknown>
  try {
    if (!raw || Buffer.byteLength(raw) > 32_768) throw new Error()
    parsed = JSON.parse(raw)
    if (
      Object.keys(parsed).length !== MIGRATIONS.length ||
      MIGRATIONS.some((phase) => {
        const names = parsed[phase]
        return !Array.isArray(names) || names.some((name) => typeof name !== 'string' || !MIGRATION.test(name))
      })
    )
      throw new Error()
  } catch {
    throw new Error('Provide migration identities generated from the selected release commit')
  }
  return JSON.stringify(parsed)
}

function envValue(container: Container | undefined, key: string) {
  const settings = container?.env?.filter(({ name }) => name === key)
  return settings?.length === 1 ? settings[0].value : undefined
}

async function verifyPredecessor(servicePath: string, service: Service, lookup: ReleaseLookup) {
  const url = RUN + servicePath
  const revisions = new Set([
    service.latestReadyRevision,
    ...(service.trafficStatuses ?? []).map(({ revision }) => revision),
  ])
  const serving = service.template?.containers?.[0]
  if (service.reconciling || envValue(serving, 'RUN_MIGRATIONS') !== 'false') {
    throw new Error('The serving API must have startup migrations disabled before running release migrations')
  }
  for (const revision of revisions) {
    const prefix = `${servicePath}/revisions/`
    const name = revision?.startsWith(prefix) ? revision.slice(prefix.length) : revision
    if (
      !name ||
      !NAME.test(name) ||
      envValue((await lookup<Containers>({ url: `${url}/revisions/${name}` })).containers?.[0], 'RUN_MIGRATIONS') !==
        'false'
    ) {
      throw new Error('Unable to prove startup migrations are disabled on each reachable API revision')
    }
  }
  return serving
}

async function findResource<T>(lookup: ReleaseLookup, path: string): Promise<T | undefined> {
  try {
    return await lookup<T>({ url: RUN + path })
  } catch (error) {
    if (!(error instanceof ReleaseResourceNotFound)) throw error
  }
}

// Cloud Run can return defaulted object fields. Every submitted field and the complete
// contents of arrays such as env and containers must nevertheless match on readback.
function containsJobSpec(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => containsJobSpec(actual[index], value))
    )
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false
    return Object.entries(expected).every(
      ([key, value]) => value === undefined || containsJobSpec((actual as Record<string, unknown>)[key], value),
    )
  }
  return actual === expected
}

async function runNamedMigration({
  jobsPath,
  jobId,
  task,
  lookup,
  log,
  existingJob,
}: {
  jobsPath: string
  jobId: string
  task: JobTemplate
  lookup: ReleaseLookup
  log: ReleaseMigrationInput['log']
  existingJob?: MigrationJob
}): Promise<boolean> {
  const jobPath = `${jobsPath}/${jobId}`
  const executionPath = `${jobPath}/executions/${jobId}-${EXECUTION_TOKEN}`
  const project = jobsPath.split('/')[1]
  const resolveName = (name: string | undefined) => name?.replace(/^projects\/\d+\//, `projects/${project}/`)
  const template = { taskCount: 1, parallelism: 1, template: task }
  let job = existingJob ?? (await findResource<MigrationJob>(lookup, jobPath))
  if (!job) {
    // One immutable Job name is the submission key. Repeating its create after
    // an absent or lost reply cannot start a second execution under that name.
    try {
      await lookup({
        url: `${RUN}${jobsPath}?jobId=${jobId}`,
        data: { startExecutionToken: EXECUTION_TOKEN, template },
      })
    } catch (error) {
      if (!(error instanceof ReleaseResourceConflict)) throw error
    }
  }
  log(`Cloud Run migration Job ${jobPath}`)
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    job ??= await findResource<MigrationJob>(lookup, jobPath)
    if (job) {
      if (
        resolveName(job.name) !== jobPath ||
        job.deleteTime ||
        (job.executionCount ?? 0) > 1 ||
        (job.latestCreatedExecution?.name && resolveName(job.latestCreatedExecution.name) !== executionPath) ||
        !containsJobSpec(job.template, template)
      ) {
        throw new Error(`Cloud Run migration Job ${jobPath} does not match the pinned submission`)
      }
      const execution = await findResource<Execution>(lookup, executionPath)
      if (execution) {
        if (
          resolveName(execution.name) !== executionPath ||
          execution.deleteTime ||
          execution.taskCount !== 1 ||
          !containsJobSpec(execution.template, task)
        ) {
          throw new Error(
            'Could not confirm successful completion of the pinned migration execution: execution differs',
          )
        }
        if (execution.completionTime) return execution.succeededCount === 1
      }
    }
    await delay(2000)
    job = undefined
  }
  throw new Error(`Cloud Run migration Job ${jobPath} has no verified terminal execution; retry the same workflow run`)
}

export async function runReleasePreDeploy(input: ReleaseMigrationInput, lookup: ReleaseLookup) {
  const expected = sourceManifest(input.expected)
  const settings = releaseIamSettings(input.declaration, input.scope, input.deployer)
  const { project, region, instance } = settings
  const runId = input.runId ?? ''
  const runAttempt = Number(input.runAttempt)
  if (!ACTION_RUN.test(runId) || !ACTION_RUN.test(input.runAttempt ?? '') || !Number.isSafeInteger(runAttempt)) {
    throw new Error('Cloud Run migration recovery requires the workflow run ID and attempt number')
  }
  const { jobPath, container, template, volumes, vpcAccess } = await readReleaseMigrationJob(settings, lookup)
  if (!container.name || !NAME.test(container.name) || JSON.stringify(container.command) !== '["node"]') {
    throw new Error('Set the migration Job container name and its command to node')
  }
  const { path, live } = await readReleaseService<Service>(settings, lookup)
  const instanceName = `${project}:${region}:${instance}`
  const host = `/cloudsql/${instanceName}`
  const awaitingFirstRevision =
    live && settings.initialProvisioning && !live.latestReadyRevision && !live.trafficStatuses?.length
  const serving =
    live && !awaitingFirstRevision ? await verifyPredecessor(path, live, lookup) : live?.template?.containers?.[0]
  if (
    awaitingFirstRevision &&
    (live.template?.serviceAccount !== settings.apiAccount ||
      serving?.image !== settings.image ||
      envValue(serving, 'RUN_MIGRATIONS') !== 'false')
  ) {
    throw new Error('The unready API does not match the verified initial release template')
  }
  if (serving && envValue(serving, 'DB_HOST') !== host) {
    throw new Error('The release API must use the declared Cloud SQL instance')
  }
  const initial = live ? undefined : await verifyInitialReleaseDatabase(settings, vpcAccess, lookup)
  const database = initial?.database ?? envValue(serving, 'DB_DATABASE')
  const application = initial?.application ?? envValue(serving, 'DB_USERNAME')
  const candidate = input.readCandidate?.()
  if (
    !candidate ||
    candidate.database !== database ||
    candidate.application !== application ||
    candidate.service !== settings.service ||
    candidate.account !== settings.apiAccount ||
    candidate.instance !== settings.instance
  ) {
    throw new Error('Release migration database must match the rendered API database and identity')
  }
  const username = envValue(container, 'DB_USERNAME')
  const mount = container.volumeMounts?.find(({ mountPath }) => mountPath === '/cloudsql')
  const cloudSql = volumes?.find(({ name }) => name === mount?.name)?.cloudSqlInstance?.instances
  if (
    !database ||
    envValue(container, 'DB_DATABASE') !== database ||
    envValue(container, 'DB_HOST') !== host ||
    !mount?.name ||
    cloudSql?.length !== 1 ||
    cloudSql[0] !== instanceName
  ) {
    throw new Error('The migration Job must use the declared release database')
  }
  if (!application || !username || username === application) {
    throw new Error('The migration Job and serving API must use separate database logins')
  }
  const identities = { name: 'BOXLITE_EXPECTED_MIGRATIONS', value: expected }
  const databaseProof = { name: 'BOXLITE_EXPECTED_DATABASE', value: JSON.stringify({ database, username }) }
  const expansion = live ? ['run', 'pre-deploy', '--require-admission-closed'] : BOOTSTRAP_COMMAND
  const jobsPath = jobPath.slice(0, jobPath.lastIndexOf('/'))
  for (const invocation of [
    { command: ['check-database'], environment: databaseProof },
    { command: expansion, environment: identities },
    { command: ['verify', 'pre-deploy'], environment: identities },
  ]) {
    const env = (container.env ?? []).filter(({ name }) => name !== invocation.environment.name)
    const taskFor = (command: string[]): JobTemplate => ({
      ...template,
      maxRetries: 0,
      containers: [
        { ...container, args: ['dist/apps/api/migrate.js', ...command], env: [...env, invocation.environment] },
      ],
    })
    // Read-only probes run fresh on each workflow retry. A mutating phase can
    // move to a new name only after a previous execution has terminally failed.
    const mutating = invocation.command[0] === 'run'
    let resumingBootstrap = false
    for (let attempt = mutating ? 1 : runAttempt; attempt <= runAttempt; attempt++) {
      const hash = createHash('sha256')
        .update(JSON.stringify([jobPath, runId, invocation.command[0], attempt]))
        .digest('hex')
      const jobId = `release-migrate-${hash.slice(0, 32)}`
      const existingJob =
        live && mutating && settings.initialProvisioning
          ? await findResource<MigrationJob>(lookup, `${jobsPath}/${jobId}`)
          : undefined
      const bootstrapTask = taskFor(BOOTSTRAP_COMMAND)
      const wasBootstrap = existingJob && containsJobSpec(existingJob.template?.template, bootstrapTask)
      if (wasBootstrap && !resumingBootstrap) {
        if (!awaitingFirstRevision)
          await verifyReleaseApi(input.declaration, input.scope, input.deployer, candidate, lookup)
        resumingBootstrap = true
      }
      if (mutating && (awaitingFirstRevision || resumingBootstrap) && !wasBootstrap) {
        throw new Error('A serving API requires a completed initial migration Job from this workflow')
      }
      const task = wasBootstrap ? bootstrapTask : taskFor(invocation.command)
      if (await runNamedMigration({ jobsPath, jobId, task, lookup, log: input.log, existingJob })) break
      if (attempt === runAttempt)
        throw new Error('Could not confirm successful completion of the pinned migration execution')
    }
  }
  return settings.image
}

export async function runReleasePreDeployWithAdc(input: ReleaseMigrationInput) {
  const { lookup, releaseAccount } = await releaseLookupWithAdc(input.deployer)
  return runReleasePreDeploy({ ...input, deployer: releaseAccount }, lookup)
}

export async function verifyReleaseApi(
  declaration: string | undefined,
  scope: ReleaseScope,
  deployer: string | undefined,
  candidate: ReleaseApiBinding,
  lookup: ReleaseLookup,
) {
  const settings = releaseIamSettings(declaration, scope, deployer)
  if (
    candidate.service !== settings.service ||
    candidate.account !== settings.apiAccount ||
    candidate.instance !== settings.instance
  ) {
    throw new Error('Release API resource bindings differ from the selected deployment')
  }
  const { live, path } = await readReleaseService<Service>(settings, lookup)
  const prefix = `${path}/revisions/`
  const nameOf = (name?: string) => (name?.startsWith(prefix) ? name.slice(prefix.length) : name)
  const ready = nameOf(live?.latestReadyRevision)
  const traffic = live?.trafficStatuses ?? []
  if (
    live?.reconciling ||
    !ready ||
    !NAME.test(ready) ||
    traffic.reduce((total, target) => total + (target.percent ?? 0), 0) !== 100 ||
    traffic.some((target) => nameOf(target.revision) !== ready)
  ) {
    throw new Error('The selected release must serve all API traffic and tagged routes')
  }
  const revision = await lookup<Revision>({ url: `${RUN}${prefix}${ready}` })
  const serving = revision.containers?.[0]
  if (
    revision.reconciling ||
    revision.serviceAccount !== candidate.account ||
    serving?.image !== settings.image ||
    envValue(serving, 'RUN_MIGRATIONS') !== 'false' ||
    envValue(serving, 'DB_HOST') !== `/cloudsql/${settings.project}:${settings.region}:${settings.instance}` ||
    envValue(serving, 'DB_DATABASE') !== candidate.database ||
    envValue(serving, 'DB_USERNAME') !== candidate.application
  ) {
    throw new Error('The serving API revision does not match the selected image, identity, or database')
  }
}

export async function verifyReleaseApiWithAdc(
  declaration: string | undefined,
  scope: ReleaseScope,
  deployer: string | undefined,
  candidate: ReleaseApiBinding,
) {
  const { lookup, releaseAccount } = await releaseLookupWithAdc(deployer)
  await verifyReleaseApi(declaration, scope, releaseAccount, candidate, lookup)
}
