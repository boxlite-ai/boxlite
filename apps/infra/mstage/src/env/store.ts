/*
 * A stage's configuration, whichever cloud keeps it.
 *
 * Everything here is the same on every cloud: how a value is sealed, what a
 * name may be, that a write is one read-modify-write, that a missing key is
 * reported rather than raised. Where the bytes live is a `StoreBackend`, and
 * this module never learns which one it was handed — so leaving a cloud does
 * not mean rewriting how configuration works.
 */

import { EnvError, objectKey, open, seal, type StoreBackend, type StoredVersion } from './backend.ts'
import { awsBackend, ambientClients as awsAmbientClients, clientsFor as awsClientsFor } from './aws-backend.ts'
import type { AwsIdentity } from '../aws/identity.ts'

export { EnvError, type StoreBackend, type StoredVersion }
export { readStateBucket } from './aws-backend.ts'

/** The AWS clients, under their old names because every caller builds them. */
export type Clients = ReturnType<typeof awsClientsFor>
export const clientsFor = (identity: Pick<AwsIdentity, 'credentials' | 'region'>): Clients => awsClientsFor(identity)
export const ambientClients = (region: string): Clients => awsAmbientClients(region)

/**
 * Where AWS clients become a backend. The overload leaves existing call sites
 * unchanged while letting a GCP caller pass a backend it built itself.
 */
const backendFrom = (source: Clients | StoreBackend): StoreBackend =>
  'home' in source ? source : awsBackend(source)

/** One stage's map. A stage that was never written is empty rather than an error. */
export const readEnvironment = async ({
  clients,
  app,
  stage,
  versionId,
}: {
  clients: Clients | StoreBackend
  app: string
  stage: string
  /** Read the object as it was, not as it is. See `currentVersion`. */
  versionId?: string
}): Promise<Record<string, string>> => {
  const backend = backendFrom(clients)
  const sealed = await backend.read({ app, stage, ...(versionId ? { versionId } : {}) })
  if (!sealed) return {}
  const key = objectKey(app, stage)
  const parsed: unknown = JSON.parse(open(sealed, await backend.passphrase({ app, stage }), key))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvError(`${key} did not decrypt to an object`)
  }
  return parsed as Record<string, string>
}

/**
 * Which version of a stage's object is current. A deploy records it, so a task
 * restarting hours later reads the configuration the deploy was built against
 * rather than someone else's later edit.
 */
export const currentVersion = async ({
  clients,
  app,
  stage,
}: {
  clients: Clients | StoreBackend
  app: string
  stage: string
}): Promise<string | null> => backendFrom(clients).currentVersion({ app, stage })

/**
 * Every version of a stage's object, newest first. Delete markers are listed
 * rather than filtered: a stage that reads as empty is usually explained by one.
 */
export const listVersions = async ({
  clients,
  app,
  stage,
}: {
  clients: Clients | StoreBackend
  app: string
  stage: string
}): Promise<StoredVersion[]> => backendFrom(clients).versions({ app, stage })

/** Replaces one stage's map, sealed the way every backend reads it. */
export const writeStage = async ({
  clients,
  app,
  stage,
  values,
}: {
  clients: Clients | StoreBackend
  app: string
  stage: string
  values: Record<string, string>
}): Promise<void> => {
  const backend = backendFrom(clients)
  const key = objectKey(app, stage)
  const sealed = seal(JSON.stringify(values), await backend.passphrase({ app, stage }), key)
  await backend.write({ app, stage, sealed })
}

/** SST's constraint on a name set through `secret set` (cmd/sst/secret.go:363). */
export const SECRET_NAME = /^[A-Z][a-zA-Z0-9_]*$/

export type WriteOutcome = { name: string; existed: boolean; unchanged: boolean }

/**
 * Sets one or more keys in a single read-modify-write. The store is one object,
 * so writing per key would cost a round trip each and widen the window in which
 * a concurrent writer loses somebody's change.
 *
 * `derive` runs after the assignments and before the write, for a value that
 * depends on the others — a digest cannot be computed until the result exists,
 * and must not need a second write to land.
 */
export const setValues = async ({
  clients,
  app,
  stage,
  entries,
  derive,
}: {
  clients: Clients | StoreBackend
  app: string
  stage: string
  entries: [string, string][]
  derive?: (values: Record<string, string>) => [string, string][]
}): Promise<{ outcomes: WriteOutcome[] }> => {
  for (const [name] of entries) {
    if (!SECRET_NAME.test(name)) {
      throw new EnvError(`"${name}" is not a usable name; SST requires ${SECRET_NAME.source}`)
    }
  }
  const backend = backendFrom(clients)
  const current = await readEnvironment({ clients: backend, app, stage })

  const next = { ...current }
  const outcomes: WriteOutcome[] = []
  const record = (name: string, value: string) => {
    outcomes.push({ name, existed: Object.hasOwn(current, name), unchanged: current[name] === value })
    next[name] = value
  }
  for (const [name, value] of entries) record(name, value)
  for (const [name, value] of derive?.(next) ?? []) record(name, value)

  if (outcomes.some((outcome) => !outcome.unchanged)) {
    await writeStage({ clients: backend, app, stage, values: next })
  }
  return { outcomes }
}

export type DeleteOutcome = { name: string; existed: boolean }

/**
 * Removes keys in a single read-modify-write, for the same reason `setValues`
 * makes one write.
 *
 * A key that was not there is reported rather than failed: the caller asked for
 * it to be gone, and it is. When none was there the object is not resealed.
 *
 * Nothing is derived here. A removal either leaves a group alone, so its stored
 * fingerprint still describes it, or takes a member out of it — which no
 * recomputation can make true while the group still names that member.
 */
export const deleteValues = async ({
  clients,
  app,
  stage,
  names,
}: {
  clients: Clients | StoreBackend
  app: string
  stage: string
  names: readonly string[]
}): Promise<{ outcomes: DeleteOutcome[] }> => {
  const backend = backendFrom(clients)
  const current = await readEnvironment({ clients: backend, app, stage })
  // `hasOwn`, not `in`, for the reason `setValues` uses it: the map came out of
  // `JSON.parse`, so it inherits `toString` and the rest of Object.prototype.
  const outcomes = names.map((name) => ({ name, existed: Object.hasOwn(current, name) }))
  if (outcomes.some((outcome) => outcome.existed)) {
    const rest = Object.fromEntries(Object.entries(current).filter(([key]) => !names.includes(key)))
    await writeStage({ clients: backend, app, stage, values: rest })
  }
  return { outcomes }
}
