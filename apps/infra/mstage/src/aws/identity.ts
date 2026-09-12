/**
 * The AWS identity a command acts under.
 *
 * The SDK's default credential chain and nothing else: whatever `aws login`,
 * CI or a container role left behind. mstage adds no selection, translates no
 * error, and has no opinion about which account is reached — a caller needing
 * the account asks `whoami`.
 *
 * The credential *provider* is passed through rather than a resolved triple, so
 * short-lived sources keep refreshing. SST instead freezes its triple into
 * `SST_AWS_ACCESS_KEY_ID` at startup (pkg/project/provider/aws.go:48-62) and
 * uses it with no refresh path.
 */

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentityProvider } from '@smithy/types'
import type { Scope } from './precedence.ts'
import type { Caller as TenantCaller, Identity } from '../identity.ts'
import { childEnvironment } from './child-env.ts'

export type Caller = { accountId?: string; arn?: string; userId?: string }

/** The shared `Identity`, plus the SDK provider every AWS client is built from. */
export type AwsIdentity = Identity & {
  readonly home: 'aws'
  /** Kept for the SDK clients. Nothing outside the AWS backend should read it. */
  credentials: AwsCredentialIdentityProvider
}

export const buildCredentials = (scope: Scope): AwsCredentialIdentityProvider => {
  const base = fromNodeProviderChain({ clientConfig: { region: scope.region } })
  if (!scope.roleArn) return base
  return fromTemporaryCredentials({
    masterCredentials: base,
    params: { RoleArn: scope.roleArn, RoleSessionName: scope.roleSessionName ?? 'mstage' },
    clientConfig: { region: scope.region },
  })
}

export const resolveIdentity = ({
  scope,
  createSts,
  credentialsFor = buildCredentials,
}: {
  scope: Scope
  createSts?: (config: any) => { send: (command: any) => Promise<any>; destroy?: () => void }
  credentialsFor?: (scope: Scope) => AwsCredentialIdentityProvider
}): AwsIdentity => {
  const credentials = credentialsFor(scope)
  const newSts = createSts ?? ((config: any) => new STSClient(config) as any)
  let caller: Caller | null = null

  const whoami = async (): Promise<Caller> => {
    if (caller) return caller
    const client = newSts({ region: scope.region, credentials })
    try {
      const answer = await client.send(new GetCallerIdentityCommand({}))
      caller = { accountId: answer.Account, arn: answer.Arn, userId: answer.UserId }
      return caller
    } finally {
      client.destroy?.()
    }
  }

  const identity: AwsIdentity = {
    home: 'aws',
    credentials,
    region: scope.region,
    stage: scope.stage,
    app: scope.app,
    whoami: async (): Promise<TenantCaller> => {
      const { accountId, arn } = await whoami()
      return { ...(accountId ? { tenant: accountId } : {}), ...(arn ? { principal: arn } : {}) }
    },
    async expiresAt() {
      return (await credentials()).expiration ?? null
    },
    /** Fails before a long operation starts rather than part-way through it. */
    async assertUsableFor(seconds: number, now: () => Date = () => new Date()) {
      const { expiration } = await credentials()
      if (!expiration) return
      const remaining = (expiration.getTime() - now().getTime()) / 1000
      if (remaining < seconds) {
        throw new Error(
          `These credentials expire in ${Math.max(0, Math.round(remaining))}s, ` +
            `less than the ${seconds}s this command needs. Sign in again.`,
        )
      }
    },
    // Three variables, every competing one cleared. They do not refresh, which
    // is why `assertUsableFor` has something to say on this cloud.
    childEnvironment: (base) => childEnvironment({ scope, identity, ...(base ? { base } : {}) }),
  }
  return identity
}
