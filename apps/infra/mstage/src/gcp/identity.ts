/*
 * Who a command is running as on GCP.
 *
 * Three differences from AWS, all forced by the platform rather than chosen:
 *
 * Nothing expires on a clock this can read: ADC refreshes itself, so
 * `expiresAt` answers null and `assertUsableFor` has nothing to check.
 *
 * A child inherits a path, not a key — the SDK re-reads the file — so it gets
 * `GOOGLE_APPLICATION_CREDENTIALS` and the project, with every AWS variable
 * cleared so it cannot pick up the other cloud by accident.
 *
 * The tenant is a project the caller already knows, and there is no
 * `GetCallerIdentity` worth a network call, so `whoami` asks the auth library.
 */

import type { Caller, Identity } from '../identity.ts'
import type { Scope } from '../aws/precedence.ts'

/**
 * What Google's auth library answers. Structural rather than imported, so
 * nothing needs the package installed until a GCP stage exists.
 */
export type GoogleAuth = {
  getProjectId: () => Promise<string>
  getCredentials: () => Promise<{ client_email?: string }>
}

export type GcpIdentity = Identity & { readonly home: 'gcp' }

/** Where the credentials file is, when one is being used rather than a metadata server. */
const CREDENTIALS_VARIABLE = 'GOOGLE_APPLICATION_CREDENTIALS'

export const resolveGcpIdentity = ({
  scope,
  auth,
  environment = process.env,
}: {
  scope: Scope
  auth: GoogleAuth
  environment?: NodeJS.ProcessEnv
}): GcpIdentity => {
  let caller: Caller | null = null

  const whoami = async (): Promise<Caller> => {
    if (caller) return caller
    const [project, credentials] = await Promise.all([auth.getProjectId(), auth.getCredentials()])
    caller = { tenant: project, ...(credentials.client_email ? { principal: credentials.client_email } : {}) }
    return caller
  }

  return {
    home: 'gcp',
    region: scope.region,
    stage: scope.stage,
    app: scope.app,
    whoami,

    // ADC refreshes itself: there is no deadline to report.
    async expiresAt() {
      return null
    },
    async assertUsableFor() {
      return
    },

    /**
     * The project, plus the credentials path when one is in use. Every AWS
     * variable is cleared, or a stale key triple would authenticate to the
     * other cloud and fail somewhere that mentions neither.
     */
    async childEnvironment(base = environment) {
      const env: NodeJS.ProcessEnv = { ...base }
      delete env.AWS_PROFILE
      delete env.AWS_ACCESS_KEY_ID
      delete env.AWS_SECRET_ACCESS_KEY
      delete env.AWS_SESSION_TOKEN
      delete env.AWS_REGION
      delete env.AWS_DEFAULT_REGION

      const { tenant } = await whoami()
      if (tenant) {
        env.GOOGLE_CLOUD_PROJECT = tenant
        // gcloud and the Pulumi provider read this one rather than the above.
        env.CLOUDSDK_CORE_PROJECT = tenant
      }
      env.CLOUDSDK_COMPUTE_REGION = scope.region
      const credentials = base?.[CREDENTIALS_VARIABLE]
      if (credentials) env[CREDENTIALS_VARIABLE] = credentials

      return { env, expiresAt: null }
    },
  }
}
