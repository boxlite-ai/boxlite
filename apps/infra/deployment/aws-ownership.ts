import { legacyAwsOwnership } from 'mstage/legacy-aws-ownership'

const ownershipFor = legacyAwsOwnership

/** Direct SST invocation must honor cutover even when it bypasses the checked-in wrapper. */
export const assertLegacyDeploymentAllowed = async ({
  stage,
  region,
}: {
  stage: string
  region: string
}): Promise<void> => {
  let owner
  try {
    owner = await ownershipFor(region).inspect({ app: 'boxlite', stage })
  } catch (error) {
    // A first SST install creates this regional bootstrap record itself.
    if ((error as Error).message === '/sst/bootstrap does not exist in this region; the account was never bootstrapped')
      return
    throw error
  }
  if (owner && owner.phase !== 'legacy')
    throw new Error(`SST deployment is blocked while AWS ownership is ${owner.phase}`)
}

/** Checked-in legacy and native entrypoints serialize through the same conditional S3 lease. */
export const withLegacyDeploymentOwnership = async <T>(
  { stage, region }: { stage: string; region: string },
  work: () => Promise<T>,
): Promise<T> => ownershipFor(region).run({ app: 'boxlite', stage, action: 'legacy' }, work)
