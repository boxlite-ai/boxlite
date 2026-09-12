/**
 * `mstage login` — can each provider this repository declares be reached with
 * whatever is already signed in.
 *
 * It signs nobody in and translates nobody's failure. Sign in however this
 * machine does — `aws login`, `gcloud auth login --update-adc`, `gh auth login`
 * — and mstage picks up the result. The check below is AWS's; the others live
 * in `auth/sessions.ts`.
 */

import type { AwsIdentity } from '../../aws/identity.ts'

/** Every check takes the same context and ignores what it does not need. */
export type CheckContext = { identity: AwsIdentity }
export type ProviderCheck = (context: CheckContext) => Promise<ProviderStatus>

export type ProviderStatus = {
  provider: string
  state: string
  detail: string
  expiresAt: Date | null
  required?: boolean
}

export const checkAws = async ({ identity }: { identity: AwsIdentity }): Promise<ProviderStatus> => {
  try {
    const caller = await identity.whoami()
    const expiresAt = await identity.expiresAt()
    return {
      provider: 'aws',
      state: 'ready',
      detail: `${caller.principal} in ${caller.tenant}`,
      expiresAt,
    }
  } catch (error) {
    return { provider: 'aws', state: 'not signed in', detail: (error as Error).message, expiresAt: null }
  }
}

/**
 * An optional provider that is not signed in is reported and then forgiven:
 * failing the command over one nobody provisions trains people to ignore the
 * output.
 */
export const report = async ({
  statuses,
  log,
}: {
  statuses: ProviderStatus[]
  log: (line: string) => void
}): Promise<number> => {
  let failed = false
  for (const status of statuses) {
    const suffix = status.expiresAt ? ` (expires ${status.expiresAt.toISOString()})` : ''
    const optional = status.required === false ? ' (optional)' : ''
    log(`${status.provider.padEnd(8)}${status.state}${optional}${suffix}`)
    log(`        ${status.detail}`)
    if (status.state !== 'ready' && status.required !== false) failed = true
  }
  return failed ? 1 : 0
}
