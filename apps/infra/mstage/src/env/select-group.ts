/**
 * What may leave a stage's store, and the one way to ask for it.
 *
 * `mstage.env.json` declares named groups under `env.selectGroup`, and a
 * consumer names one rather than carrying its own list. Two declarations of one
 * set drift silently, and only a test written to look for it ever finds the
 * drift — so adding a key to an export stays one reviewable edit to one file.
 */

import { loadConfig, type MstageConfig } from '../config/load.ts'
import { ambientClients, readEnvironment, type Clients, type StoreBackend } from './store.ts'

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

/** The keys one declared group names, or an error naming the groups that exist. */
export const groupKeys = ({
  group,
  groups,
  where,
}: {
  group: string
  groups: Record<string, string[]>
  where: string
}): string[] => {
  const keys = groups[group]
  if (keys) return keys
  const known = Object.keys(groups)
  throw new ExportError(
    known.length > 0
      ? `${where} declares no "${group}" under env.selectGroup. Declared: ${known.join(', ')}`
      : `${where} declares no env.selectGroup at all`,
  )
}

/**
 * Narrows a store to one declared group.
 *
 * A key the group names but the store does not hold is an error rather than an
 * omission: a process handed a silently short environment fails later, somewhere
 * that does not mention the missing key.
 *
 * `optional` names members that need not be there yet, for a caller that is
 * about to produce one. Exporting never has that case; deriving the group's own
 * digest does, because the digest is a member of the group it describes.
 */
export const valuesOfGroup = ({
  group,
  groups,
  values,
  where,
  optional = [],
}: {
  group: string
  groups: Record<string, string[]>
  values: Record<string, string>
  where: string
  optional?: string[]
}): Record<string, string> => {
  const keys = groupKeys({ group, groups, where })
  const missing = keys.filter((key) => !(key in values) && !optional.includes(key))
  if (missing.length > 0) {
    throw new ExportError(`the store is missing ${missing.join(', ')}, which env.selectGroup.${group} names`)
  }
  return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key] as string]))
}

/**
 * One group's keys and values, read from a stage's store.
 *
 * What a server or a deploy calls. It hands the values back and does nothing
 * with them — where they belong is the caller's decision, not a library's.
 *
 * `versionId` reads the object as an earlier moment saw it, so a task starting
 * again hours later reads what the deploy was built against.
 */
export const selectGroup = async ({
  group,
  stage,
  region,
  app,
  versionId,
  clients,
  config = loadConfig(),
}: {
  group: string
  stage: string
  region?: string
  app?: string
  versionId?: string
  /**
   * AWS clients from a caller that already built them, or a backend from one on
   * another cloud. `readEnvironment` takes either; narrowing this to the AWS
   * half is what once kept a GCP stage from reaching it at all.
   */
  clients?: Clients | StoreBackend
  config?: MstageConfig
}): Promise<Record<string, string>> => {
  if (!stage) throw new ExportError('selectGroup needs the stage whose store to read')
  if (!clients && !region) throw new ExportError('selectGroup needs a region, or clients already built for one')

  const values = await readEnvironment({
    clients: clients ?? ambientClients(region as string),
    app: app ?? config.app,
    stage,
    ...(versionId ? { versionId } : {}),
  })
  return valuesOfGroup({
    group,
    groups: config.envSelectGroup,
    values,
    where: config.basePath,
    // Read from the config rather than taken as an argument: a caller with
    // its own list would be a second answer to a question already asked.
    optional: config.envOptional[group] ?? [],
  })
}
