import type { Scope as MstageScope } from 'mstage/scope'
import { verifyInitialReleaseDatabase } from './release-bootstrap.ts'

// This API version also evaluates principal access boundary policies.
const IAM_LOOKUP = 'https://policytroubleshooter.googleapis.com/v3beta/iam:troubleshoot'
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const REGION = /^[a-z]+-[a-z]+[0-9]+$/
const NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SECRET = /^[A-Za-z0-9_-]{1,255}$/
const ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,62}@[a-z0-9][a-z0-9.-]*\.gserviceaccount\.com$/
const PINNED_IMAGE = /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/
const RECEIPT = /^[a-f0-9]{32}$/

export type ReleaseScope = Pick<MstageScope, 'stage' | 'project' | 'region' | 'home'>
export type JobTemplate = {
  serviceAccount?: string
  timeout?: string
  executionEnvironment?: string
  maxRetries?: number
  vpcAccess?: JobVpcAccess
  volumes?: Array<{ name?: string; cloudSqlInstance?: { instances?: string[] } }>
  containers?: {
    image?: string
    name?: string
    command?: string[]
    args?: string[]
    env?: { name?: string; value?: string; valueSource?: { secretKeyRef?: { secret?: string; version?: string } } }[]
    volumeMounts?: Array<{ name?: string; mountPath?: string }>
  }[]
}
export type JobVpcAccess = { egress?: string; networkInterfaces?: { subnetwork?: string }[] }
export type ReleaseLookup = <T>(input: { url: string; data?: object }) => Promise<T>

export class ReleaseResourceNotFound extends Error {}
export class ReleaseResourceConflict extends Error {}

function required(input: unknown, pattern: RegExp, name: string): string {
  if (typeof input !== 'string' || !pattern.test(input)) throw new Error(`Invalid release IAM field ${name}`)
  return input
}

export function releaseIamSettings(raw: string | undefined, scope: ReleaseScope, deployer: string | undefined) {
  if (scope.home !== 'gcp') throw new Error('Release IAM verification requires a GCP stage')
  if (!raw || Buffer.byteLength(raw) > 32_768) throw new Error('Missing or oversized BOXLITE_RELEASE_IAM declaration')
  let input: Record<string, unknown>
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error('Invalid BOXLITE_RELEASE_IAM JSON')
  }
  const project = required(scope.project, PROJECT, 'project')
  const region = required(scope.region, REGION, 'region')
  const stage = required(scope.stage, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'stage')
  if (input?.stage !== stage || input?.project !== project)
    throw new Error('Release IAM declaration is for another stage')
  const apiAccount = required(input.apiAccount, ACCOUNT, 'apiAccount')
  const ownerAccount = required(input.ownerAccount, ACCOUNT, 'ownerAccount')
  const releaseAccount = required(deployer, ACCOUNT, 'GCP_DEPLOYER')
  const projectAccount = `@${project}.iam.gserviceaccount.com`
  if (!ownerAccount.endsWith(projectAccount) || !releaseAccount.endsWith(projectAccount)) {
    throw new Error('Protected release accounts must belong to the stage project')
  }
  if (!Array.isArray(input.ordinaryAccounts) || input.ordinaryAccounts.length > 24) {
    throw new Error('Release IAM declaration requires an inventory of other deployment accounts')
  }
  const ordinaryAccounts = input.ordinaryAccounts.map((account) => required(account, ACCOUNT, 'ordinaryAccounts'))
  const untrusted = new Set([apiAccount, ...ordinaryAccounts])
  if (ownerAccount === releaseAccount || untrusted.has(ownerAccount) || untrusted.has(releaseAccount)) {
    throw new Error('Release, migration Job, serving, and ordinary deployment privileges are not separated')
  }
  const image = required(input.image, PINNED_IMAGE, 'image')
  if (image.split('/')[1] !== project) throw new Error('Release image is outside the stage project')
  const initial = input.initialProvisioning
  if (initial !== undefined && (initial === null || typeof initial !== 'object' || Array.isArray(initial))) {
    throw new Error('Invalid initialProvisioning declaration')
  }
  const bootstrap = initial as Record<string, unknown> | undefined
  return {
    project,
    region,
    ownerAccount,
    releaseAccount,
    apiAccount,
    untrusted,
    job: required(input.job, NAME, 'job'),
    service: required(input.service, NAME, 'service'),
    instance: required(input.instance, NAME, 'instance'),
    ownerSecret: required(input.ownerSecret, SECRET, 'ownerSecret'),
    ownerSecretVersion: required(input.ownerSecretVersion, /^[1-9]\d*$/, 'ownerSecretVersion'),
    image,
    initialProvisioning: bootstrap && {
      receipt: required(bootstrap.receipt, RECEIPT, 'initialProvisioning.receipt'),
      database: required(bootstrap.database, SQL_IDENTIFIER, 'initialProvisioning.database'),
      application: required(bootstrap.application, SQL_IDENTIFIER, 'initialProvisioning.application'),
      subnetwork: required(bootstrap.subnetwork, NAME, 'initialProvisioning.subnetwork'),
    },
  }
}

export type ReleaseSettings = ReturnType<typeof releaseIamSettings>

export async function readReleaseService<T>(settings: ReleaseSettings, lookup: ReleaseLookup) {
  const { project, region, service, initialProvisioning } = settings
  const path = `projects/${project}/locations/${region}/services/${service}`
  try {
    const live = await lookup<T>({ url: `https://run.googleapis.com/v2/${path}` })
    if (typeof live !== 'object' || live === null || Array.isArray(live)) throw new Error('Malformed Cloud Run service')
    return { path, live }
  } catch (error) {
    if (!initialProvisioning || !(error instanceof ReleaseResourceNotFound)) throw error
    return { path, live: null }
  }
}

const accountMutation = [
  'iam.serviceAccounts.actAs',
  'iam.serviceAccounts.getAccessToken',
  'iam.serviceAccounts.getOpenIdToken',
  'iam.serviceAccounts.signBlob',
  'iam.serviceAccounts.signJwt',
  'iam.serviceAccounts.implicitDelegation',
  'iam.serviceAccounts.setIamPolicy',
  'iam.serviceAccountKeys.create',
  'iam.serviceAccountKeys.upload',
]

export async function readReleaseMigrationJob(settings: ReleaseSettings, lookup: ReleaseLookup) {
  const { project, region, ownerAccount, job, ownerSecret, ownerSecretVersion, image } = settings
  const jobPath = `projects/${project}/locations/${region}/jobs/${job}`
  const secretPath = `projects/${project}/secrets/${ownerSecret}`
  const live = await lookup<{
    template?: { template?: JobTemplate }
    reconciling?: boolean
    deleteTime?: string
  }>({
    url: `https://run.googleapis.com/v2/${jobPath}`,
  })
  const template = live.template?.template
  const container = template?.containers?.[0]
  const passwordBindings = container?.env?.filter(({ name }) => name === 'DB_PASSWORD') ?? []
  const secret = passwordBindings[0]?.valueSource?.secretKeyRef
  if (
    live.reconciling ||
    live.deleteTime ||
    template?.serviceAccount !== ownerAccount ||
    template.containers?.length !== 1 ||
    container?.image !== image ||
    passwordBindings.length !== 1 ||
    secret?.secret !== secretPath ||
    secret.version !== ownerSecretVersion
  ) {
    throw new Error('Live migration Job does not match the pinned image, owner account, and secret version')
  }
  return { jobPath, secretPath, container, template, volumes: template.volumes, vpcAccess: template.vpcAccess }
}

export async function verifyReleaseIam(
  raw: string | undefined,
  scope: ReleaseScope,
  deployer: string | undefined,
  lookup: ReleaseLookup,
) {
  const settings = releaseIamSettings(raw, scope, deployer)
  const { project, ownerAccount, releaseAccount, apiAccount, untrusted, instance } = settings
  const { jobPath, secretPath, vpcAccess } = await readReleaseMigrationJob(settings, lookup)
  const { path: servicePath, live } = await readReleaseService<{ template?: { serviceAccount?: string } }>(
    settings,
    lookup,
  )
  if (live && live.template?.serviceAccount !== apiAccount)
    throw new Error('Live API service account does not match the declaration')
  if (!live) await verifyInitialReleaseDatabase(settings, vpcAccess, lookup)

  const jobResource = `//run.googleapis.com/${jobPath}`
  const secretResource = `//secretmanager.googleapis.com/${secretPath}`
  const projectResource = `//cloudresourcemanager.googleapis.com/projects/${project}`
  const accountResource = (account: string) => `//iam.googleapis.com/projects/${project}/serviceAccounts/${account}`
  const negative = {
    [jobResource]: [
      'run.jobs.update',
      'run.jobs.delete',
      'run.jobs.run',
      'run.jobs.runWithOverrides',
      'run.jobs.setIamPolicy',
    ],
    ...(live
      ? {
          [`//run.googleapis.com/${servicePath}`]: [
            'run.services.update',
            'run.services.delete',
            'run.services.setIamPolicy',
          ],
        }
      : {}),
    [accountResource(ownerAccount)]: accountMutation,
    [accountResource(releaseAccount)]: accountMutation,
    [secretResource]: [
      'secretmanager.versions.access',
      'secretmanager.versions.add',
      'secretmanager.secrets.setIamPolicy',
    ],
    [`//cloudsql.googleapis.com/projects/${project}/instances/${instance}`]: [
      'cloudsql.users.update',
      'cloudsql.users.create',
      'cloudsql.instances.update',
    ],
    [projectResource]: [
      'resourcemanager.projects.setIamPolicy',
      'iam.roles.update',
      'iam.workloadIdentityPoolProviders.update',
      'run.services.create',
      'run.jobs.create',
    ],
  }
  const positive = [
    [releaseAccount, jobResource, 'run.jobs.get'],
    [releaseAccount, projectResource, 'run.jobs.create'],
    [releaseAccount, projectResource, 'run.jobs.get'],
    [releaseAccount, projectResource, 'run.executions.get'],
    [releaseAccount, accountResource(ownerAccount), 'iam.serviceAccounts.actAs'],
    [ownerAccount, secretResource, 'secretmanager.versions.access'],
  ]
  const checks = [
    ...positive.map(([principal, fullResourceName, permission]) => ({
      principal,
      fullResourceName,
      permission,
      allowed: true,
    })),
    ...Array.from(untrusted, (principal) =>
      Object.entries(negative).flatMap(([fullResourceName, permissions]) =>
        permissions.map((permission) => ({ principal, fullResourceName, permission, allowed: false })),
      ),
    ).flat(),
  ]
  for (let i = 0; i < checks.length; i += 8) {
    await Promise.all(
      checks.slice(i, i + 8).map(async ({ allowed, ...accessTuple }) => {
        const { overallAccessState } = await lookup<{ overallAccessState?: string }>({
          url: IAM_LOOKUP,
          data: { accessTuple },
        })
        if (overallAccessState !== (allowed ? 'CAN_ACCESS' : 'CANNOT_ACCESS')) {
          throw new Error(
            `Release IAM proof failed for ${accessTuple.principal} ${accessTuple.permission} on ${accessTuple.fullResourceName}`,
          )
        }
      }),
    )
  }
  return checks.length
}

export async function federatedReleaseDeployer(deployer: string | undefined) {
  const releaseAccount = required(deployer, ACCOUNT, 'GCP_DEPLOYER')
  const { BaseExternalAccountClient, GoogleAuth } = await import('google-auth-library')
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const client = await auth.getClient().catch(() => {
    throw new Error('Release preflight could not initialize federated GCP credentials')
  })
  if (!(client instanceof BaseExternalAccountClient) || client.getServiceAccountEmail() !== releaseAccount) {
    throw new Error('Release preflight requires federated credentials for GCP_DEPLOYER')
  }
  return { auth, releaseAccount }
}

export async function releaseLookupWithAdc(deployer: string | undefined) {
  const { auth, releaseAccount } = await federatedReleaseDeployer(deployer)
  const lookup: ReleaseLookup = async <T>({ url, data }: { url: string; data?: object }) => {
    try {
      const reply = await auth.request<T>({ url, method: data ? 'POST' : 'GET', data, timeout: 15_000, retry: false })
      return reply.data
    } catch (error) {
      // Client errors can contain request headers. Never print the raw error from ADC.
      const status =
        error && typeof error === 'object' && 'response' in error
          ? (error.response as { status?: number } | undefined)?.status
          : undefined
      const host = new URL(url).hostname
      if (!data && status === 404) throw new ReleaseResourceNotFound(`Release resource not found at ${host}`)
      if (data && status === 409) throw new ReleaseResourceConflict(`Release resource already exists at ${host}`)
      throw new Error(`Release request failed at ${host}${status === undefined ? '' : ` (HTTP ${status})`}`)
    }
  }
  return { lookup, releaseAccount }
}

export async function verifyReleaseIamWithAdc(
  raw: string | undefined,
  scope: ReleaseScope,
  deployer: string | undefined,
) {
  const { lookup, releaseAccount } = await releaseLookupWithAdc(deployer)
  return verifyReleaseIam(raw, scope, releaseAccount, lookup)
}
