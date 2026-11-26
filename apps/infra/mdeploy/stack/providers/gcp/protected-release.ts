import { instanceFor } from 'naming'
import type { Database } from '../../database.ts'
import type { Placement } from '../../network.ts'
import { registrationDir } from '../../runner-registration.ts'
import { containerEnvironment, secretCoordinatesOf, secretIdOf, splitSecretRef } from './secret-env.ts'

export const PROTECTED_RELEASE_ADMIN_REF = 'OUTBOUND_PROXY_RELEASE_DB_ADMIN_PASSWORD'
export const PROTECTED_RELEASE_DEV_ORGANIZATION = 'OUTBOUND_PROXY_DEV_ACCEPTANCE_ORGANIZATION'
export const PROTECTED_RELEASE_RUNTIME_USER = 'boxlite_runtime'

export type DevAcceptance = { runId: string; repository: string; commit: string }
export type GcpProtectedRelease = {
  deployer: string
  adminRef: string
  key: string
  cutoverTestKey?: string
  acceptance?: DevAcceptance
  devAcceptance?: { organization: string; commit: string }
}

export function protectedReleaseJobName(scope: { app: string; stage: string }): string {
  return instanceFor({ ...scope, artifact: 'proxy-release' })
}

export function createProtectedDatabaseRelease({
  release,
  project,
  region,
  placement,
  image,
  database,
  pins,
  clientCredentials,
}: {
  release: GcpProtectedRelease
  project: string
  region: string
  placement: Extract<Placement, { cloud: 'gcp' }>
  image: $util.Input<string>
  database: Database
  pins: $util.Input<string>
  clientCredentials: string
}) {
  if (database.binding.cloud !== 'gcp') throw new Error('Protected release requires Cloud SQL')
  if (!/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(release.deployer)) {
    throw new Error('Protected release requires the existing GCP_DEPLOYER service account')
  }
  const adminSecret = secretCoordinatesOf(release.adminRef)
  if (adminSecret.project !== project || !/^[1-9][0-9]*$/.test(splitSecretRef(release.adminRef).version)) {
    throw new Error('Protected release requires a pinned database admin secret in the stage project')
  }

  const password = new random.RandomPassword('ProtectedApiDatabasePassword', { length: 48, special: false })
  const secret = new gcp.secretmanager.Secret('ProtectedApiDatabasePasswordSecret', {
    project,
    secretId: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-runtime-db-password' }),
    replication: { auto: {} },
  })
  const version = new gcp.secretmanager.SecretVersion('ProtectedApiDatabasePasswordValue', {
    secret: secret.id,
    secretData: $util.secret(password.result),
  })

  const deploymentAccount = `serviceAccount:${release.deployer}`
  const databaseGrant = new gcp.projects.IAMMember('ProtectedReleaseDatabaseClient', {
    project,
    role: 'roles/cloudsql.client',
    member: deploymentAccount,
  })
  const addresses = {
    PROTECTED_RELEASE_DB_ADMIN_PASSWORD: release.adminRef,
    PROTECTED_RELEASE_DB_FORMER_PASSWORD: database.binding.passwordRef,
    PROTECTED_RELEASE_DB_RUNTIME_PASSWORD: version.name,
  }
  const access = Object.entries(addresses).map(([key, reference]) =>
    new gcp.secretmanager.SecretIamMember(`ProtectedReleaseAccess-${key}`, {
      project,
      secretId: $util.output(reference).apply((ref: string) => secretIdOf(ref)),
      role: 'roles/secretmanager.secretAccessor',
      member: deploymentAccount,
    }),
  )
  const job = new gcp.cloudrunv2.Job('ProtectedDatabaseRelease', {
    name: protectedReleaseJobName({ app: $app.name, stage: $app.stage }),
    location: region,
    project,
    deletionProtection: false,
    template: {
      template: {
        serviceAccount: release.deployer,
        maxRetries: 0,
        timeout: '120s',
        vpcAccess: {
          egress: 'PRIVATE_RANGES_ONLY',
          networkInterfaces: [{ subnetwork: placement.egressSubnetwork }],
        },
        volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: [database.binding.connectionName] } }],
        containers: [{
          image,
          args: ['--protected-release-db', 'prepare'],
          volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
          envs: containerEnvironment({
            values: {
              PROTECTED_RELEASE_DB_HOST: database.connection.host,
              PROTECTED_RELEASE_DB_NAME: database.connection.database,
              PROTECTED_RELEASE_DB_ADMIN_USER: 'postgres',
              PROTECTED_RELEASE_DB_FORMER_USER: database.connection.username,
              PROTECTED_RELEASE_DB_RUNTIME_USER: PROTECTED_RELEASE_RUNTIME_USER,
              PROTECTED_RELEASE_KEY: release.key,
              PROTECTED_RELEASE_PINS: pins,
              PROTECTED_RELEASE_CLIENT_CREDENTIAL_VERSIONS: clientCredentials,
              PROTECTED_RELEASE_STAGE: $app.stage,
              ...($app.stage === 'dev' && release.devAcceptance
                ? {
                    PROTECTED_RELEASE_DEV_ORGANIZATION: release.devAcceptance.organization,
                    PROTECTED_RELEASE_DEV_COMMIT: release.devAcceptance.commit,
                  }
                : {}),
            },
            addresses,
          }),
        }],
      },
    },
  }, { dependsOn: [...database.ready, version, databaseGrant, ...access] })

  const prepare = new command.local.Command('PrepareProtectedApiDatabaseLogin', {
    dir: registrationDir(),
    create: 'node scripts/protected-runner-release.mjs prepare-database',
    update: 'node scripts/protected-runner-release.mjs prepare-database',
    environment: { RELEASE_PROJECT: project, RELEASE_REGION: region, RELEASE_DB_JOB: job.name },
    triggers: [image, release.key],
  }, { dependsOn: [job] })
  return { passwordRef: version.name, ready: prepare }
}
