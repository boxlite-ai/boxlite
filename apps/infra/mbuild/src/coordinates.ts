/*
 * Where a stage's registry lives, in the words that kind of registry uses.
 *
 * ECR is addressed by account, Artifact Registry by project. The account comes
 * from the caller's credentials, so the address cannot disagree with the
 * authorisation; a project cannot be read that way — nothing here holds a
 * Google identity — so it comes from the file that declares where a stage lives.
 *
 * In `src/` rather than `bin/` because it decides something, and a rule that
 * can be wrong belongs where a test can reach it.
 */

import type { RegistryConfig } from './config.ts'

export class CoordinatesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoordinatesError'
  }
}

/** What `resolveRegistry` needs beyond the stage's own declaration. */
export type Coordinates = { accountId: string } | { project: string }

export type CoordinatesInput = {
  stage: string
  kind: RegistryConfig['kind']
  /** The project the stage declares. Null on AWS. */
  project: string | null
  /** The account the credentials in hand belong to. Asked only when ECR needs it. */
  accountId: () => Promise<string>
}

export const coordinatesOf = async ({ stage, kind, project, accountId }: CoordinatesInput): Promise<Coordinates> => {
  if (kind === 'ecr') return { accountId: await accountId() }
  if (!project) {
    throw new CoordinatesError(`stage "${stage}" declares no project, which is where it publishes to`)
  }
  return { project }
}

/**
 * Whether one image can be promoted between two stages. A promotion copies
 * between two registries with one identity, and no identity holds both clouds
 * — refused up front, or the pull authenticates and the push fails midway.
 */
export const assertPromotable = ({
  from,
  to,
}: {
  from: { stage: string; kind: RegistryConfig['kind'] }
  to: { stage: string; kind: RegistryConfig['kind'] }
}): void => {
  if (from.kind === to.kind) return
  throw new CoordinatesError(
    `Cannot promote ${from.stage} (${from.kind}) to ${to.stage} (${to.kind}): ` +
      'a promotion copies within one registry kind, using one identity',
  )
}
