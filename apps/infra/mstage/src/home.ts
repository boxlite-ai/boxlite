/*
 * Which cloud a stage lives in, resolved once.
 *
 * Each stage in `.mstage.config.json` declares its own `home`, and that answer
 * arrives here on the scope. This is the only place it becomes an identity, a
 * store backend and a bucket. Everything above works against those interfaces
 * and never learns which cloud answered.
 *
 * The mirror of mdeploy's per-cloud provider bundles: one file where the cloud
 * is chosen, rather than a branch at every call site. The stage contributes the
 * coordinates — its region, and the account or project it is pinned to.
 *
 * Google's SDKs are imported lazily, only for a GCP stage: an AWS-only
 * repository never installs them, and in a mixed one an AWS deploy never pays
 * for them either.
 */

import { awsBackend, clientsFor, readStateBucket as awsStateBucket } from './env/aws-backend.ts'
import { gcpBackend, readStateBucket as gcpStateBucket, type GcpClients } from './env/gcp-backend.ts'
import { resolveIdentity, type AwsIdentity } from './aws/identity.ts'
import { resolveGcpIdentity, type GcpIdentity, type GoogleAuth } from './gcp/identity.ts'
import type { StoreBackend } from './env/backend.ts'
import type { Scope } from './aws/precedence.ts'

export class HomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeError'
  }
}

/** What every cloud answers with, once the stage's declaration has chosen one. */
type Access = {
  backend: StoreBackend
  /**
   * The bucket this stage's state sits in — the store on both clouds, and the
   * Pulumi backend too on GCP. A function rather than a value, because reading
   * it costs a lookup and most commands never ask.
   */
  stateBucket: () => Promise<string>
}

/**
 * One resolved cloud: who you are, where the configuration is, where the state
 * is.
 *
 * A union rather than one shape, so a caller narrowing on `identity.home` gets
 * the half that cloud offers. SST needs a resolved AWS key triple and nothing
 * else produces one; checking for it at runtime would re-decide by hand the
 * question this file already answered.
 */
export type Home = (Access & { identity: AwsIdentity }) | (Access & { identity: GcpIdentity })

/**
 * The Google clients, loaded only when a GCP stage asks for them. Injectable so
 * a test can exercise the dispatch without the packages installed.
 */
export type GoogleFactory = (input: { project: string }) => Promise<{ clients: GcpClients; auth: GoogleAuth }>

/*
 * Constants rather than literals on purpose: a literal would make
 * `tsc -p mstage/tsconfig.build.json` require all three packages in every
 * repository sharing mstage, including those that have never seen GCP.
 */
const STORAGE = '@google-cloud/storage'
const SECRET_MANAGER = '@google-cloud/secret-manager'
const AUTH = 'google-auth-library'

/** Everything a Google client may do on this project's behalf. */
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'

const loadGoogle: GoogleFactory = async ({ project }) => {
  let storage: any
  let secrets: any
  let auth: any
  try {
    const [storageModule, secretsModule, authModule] = await Promise.all([
      import(STORAGE),
      import(SECRET_MANAGER),
      import(AUTH),
    ])
    storage = new storageModule.Storage({ projectId: project })
    secrets = new secretsModule.SecretManagerServiceClient({ projectId: project })
    // Application Default Credentials: whatever this machine or runner already
    // proves. mstage does not choose credentials on either cloud — it verifies
    // the tenant the ones in hand resolve to.
    auth = new authModule.GoogleAuth({ projectId: project, scopes: [CLOUD_PLATFORM] })
  } catch (error) {
    throw new HomeError(
      'A GCP stage needs @google-cloud/storage, @google-cloud/secret-manager and google-auth-library. ' +
        `Install them in this repository, or pass a factory to resolveHome. (${(error as Error).message})`,
    )
  }
  /*
   * Cast at the seam, deliberately. `GcpClients` describes structurally the
   * slice of these SDKs mstage uses, and this is the one place the real objects
   * meet that description.
   */
  return { clients: { storage, secrets } as GcpClients, auth: auth as GoogleAuth }
}

/**
 * The project a GCP stage lives in. Declared rather than discovered, unlike the
 * AWS account: the clients below cannot be built without one, so there is
 * nothing to ask before it is known.
 */
const projectOf = (scope: Scope): string => {
  if (!scope.project) {
    throw new HomeError(`Stage "${scope.stage}" has no project; a GCP stage declares which project it lives in`)
  }
  return scope.project
}

export const resolveHome = async ({ scope, google = loadGoogle }: { scope: Scope; google?: GoogleFactory }): Promise<Home> => {
  // The scope's, not the config's: the stage is the only thing that declares
  // a cloud — there is no repository default to fold over — and `resolveScope`
  // already read it. Reading it again here is what would let the two differ.
  switch (scope.home) {
    case 'aws': {
      const identity = resolveIdentity({ scope })
      const clients = clientsFor(identity)
      return { identity, backend: awsBackend(clients), stateBucket: () => awsStateBucket(clients) }
    }
    case 'gcp': {
      const project = projectOf(scope)
      const { clients, auth } = await google({ project })
      return {
        identity: resolveGcpIdentity({ scope, auth }),
        backend: gcpBackend({ clients, project }),
        stateBucket: () => gcpStateBucket(clients, project),
      }
    }
    default:
      throw new HomeError(`Unknown home "${scope.home}"; mstage keeps a stage's configuration in aws or gcp`)
  }
}
