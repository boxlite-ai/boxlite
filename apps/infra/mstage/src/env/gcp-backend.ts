/*
 * The store on GCP: one bucket, one secret per stage — and, in the same bucket,
 * the state the deploy engine keeps.
 *
 * The store's own layout is mstage's, chosen to be boring, because nothing else
 * reads it:
 *
 *   Secret Manager  mstage-bootstrap                   which bucket holds the store
 *   GCS             secret/<app>/<stage>.json          the sealed map
 *   Secret Manager  mstage-passphrase-<app>-<stage>    the key
 *
 * The objects below `state` are not mstage's to choose: Pulumi deploys a GCP
 * stage and keeps its checkpoint and locks in this bucket, so those keys are
 * read exactly as it writes them — the relationship the AWS backend has with
 * SST, against a different engine.
 *
 * The bucket is discovered rather than passed, as AWS reads `/sst/bootstrap`,
 * so moving the store is one edit to one record. The record has the same shape
 * on both clouds, `{"state": "<bucket>"}`.
 *
 * Object versions are GCS generation numbers, carried as strings so a pinned
 * version means the same thing on either cloud.
 */

import { EnvError, objectKey, type StoreBackend, type StoredVersion } from './backend.ts'

/**
 * The two Google clients, in the shape their SDKs already have. Structural
 * rather than imported, so the packages are only needed once a GCP stage is.
 */
export type GcpClients = {
  storage: {
    bucket: (name: string) => {
      file: (
        path: string,
        options?: { generation?: number },
      ) => {
        download: () => Promise<[Buffer]>
        save: (data: Buffer, options?: { contentType?: string }) => Promise<void>
        getMetadata: () => Promise<[{ generation?: string | number; updated?: string; size?: string | number }]>
        /** Only the lock files are ever deleted; the store keeps every version. */
        delete: () => Promise<unknown>
      }
      getFiles: (options: {
        prefix: string
        /** Omitted when listing distinct keys rather than one object's history. */
        versions?: boolean
      }) => Promise<[{ name: string; metadata: Record<string, unknown> }[]]>
    }
  }
  secrets: {
    accessSecretVersion: (request: { name: string }) => Promise<[{ payload?: { data?: Uint8Array | string } }]>
  }
}

const isNotFound = (error: unknown): boolean => {
  const code = (error as { code?: number | string })?.code
  // 404 from Storage, 5 (NOT_FOUND) from the Secret Manager gRPC client.
  return code === 404 || code === 5 || code === 'ENOENT'
}

const BOOTSTRAP_SECRET = 'mstage-bootstrap'

/*
 * Where the engine keeps this stage's deployment state, which is not where SST
 * keeps it.
 *
 * On AWS the engine is SST, writing `app/<app>/<stage>.json` with one
 * `lock/…` object beside it. On GCP the engine is Pulumi, whose backend keeps
 * everything under `.pulumi/` — so one bucket holds both the store and the
 * checkpoint, which is why a GCP stage needs no second cloud to deploy.
 *
 * Two differences matter. The stack path is scoped by project, which is what
 * Pulumi writes into a new backend from 3.61.0 on; the older flat layout is not
 * read here because nothing makes one. And a lock is a *directory*, one file
 * per operation holding the stage, where SST has a single object.
 *
 * `app` is the Pulumi project: mdeploy passes the app as `projectName` and the
 * stage as `stackName`, so the halves line up with SST's keys.
 */
const PULUMI = '.pulumi'

/**
 * `.pulumi/stacks/<project>/<stack>.json` — `projectReferenceStore.StackBasePath`
 * joins the stacks directory, the project and the stack name, and nothing else
 * (`pkg/backend/diy/store.go`).
 */
const checkpointKey = (app: string, stage: string): string => `${PULUMI}/stacks/${app}/${stage}.json`

/**
 * `.pulumi/locks/organization/<project>/<stack>/` — the extra segment is not a
 * typo. Locks are keyed by `FullyQualifiedName()` (`pkg/backend/diy/backend.go`)
 * while stacks are keyed by the store, which omits it. Pulumi's own docs
 * describe the lock path without the segment; getting it wrong means listing an
 * empty prefix and reporting a locked stage as free.
 */
const lockPrefix = (app: string, stage: string): string => `${PULUMI}/locks/organization/${app}/${stage}/`

/**
 * The lock files this stage currently has, by key. Listed rather than
 * addressed, because each name is a unique id the engine chose. Distinct keys,
 * not one object's history, which is why `versions` is left off.
 */
const lockFiles = async (clients: GcpClients, project: string, app: string, stage: string): Promise<string[]> => {
  const bucket = await readStateBucket(clients, project)
  const [files] = await clients.storage.bucket(bucket).getFiles({ prefix: lockPrefix(app, stage) })
  return files.map((file) => file.name).sort()
}

/** Reads one Secret Manager version, or reports what is missing. */
const secretValue = async (clients: GcpClients, name: string): Promise<string> => {
  let answer
  try {
    ;[answer] = await clients.secrets.accessSecretVersion({ name })
  } catch (error) {
    if (isNotFound(error)) throw new EnvError(`${name} does not exist`)
    throw error
  }
  const data = answer.payload?.data
  if (data === undefined) throw new EnvError(`${name} holds no value`)
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
}

/**
 * Which bucket holds the store, for this project — the GCP counterpart of
 * `/sst/bootstrap`. One record, so repointing the store is one edit.
 */
export const readStateBucket = async (clients: GcpClients, project: string): Promise<string> => {
  const name = `projects/${project}/secrets/${BOOTSTRAP_SECRET}/versions/latest`
  const raw = await secretValue(clients, name)
  let bootstrap: { state?: string }
  try {
    bootstrap = JSON.parse(raw)
  } catch {
    throw new EnvError(`${name} is not valid JSON`)
  }
  if (!bootstrap.state) throw new EnvError(`${name} names no state bucket`)
  return bootstrap.state
}

export const gcpBackend = ({ clients, project }: { clients: GcpClients; project: string }): StoreBackend => ({
  home: 'gcp',

  async read({ app, stage, versionId }) {
    const key = objectKey(app, stage)
    const generation = versionId === undefined ? undefined : Number(versionId)
    if (generation !== undefined && !Number.isInteger(generation)) {
      throw new EnvError(`"${versionId}" is not a GCS generation; versions on this backend are integers`)
    }
    try {
      const [payload] = await clients.storage
        .bucket(await readStateBucket(clients, project))
        .file(key, generation === undefined ? undefined : { generation })
        .download()
      return payload.length === 0 ? null : payload
    } catch (error) {
      if (!isNotFound(error)) throw error
      // Same rule as the other backend: an unwritten stage is empty, a pinned
      // version that has gone is a failure.
      if (versionId) throw new EnvError(`${key} has no version ${versionId}; it was deleted or expired`)
      return null
    }
  },

  async write({ app, stage, sealed }) {
    await clients.storage
      .bucket(await readStateBucket(clients, project))
      .file(objectKey(app, stage))
      .save(sealed, { contentType: 'application/json' })
  },

  async currentVersion({ app, stage }) {
    try {
      const bucket = await readStateBucket(clients, project)
      const [metadata] = await clients.storage.bucket(bucket).file(objectKey(app, stage)).getMetadata()
      return metadata.generation === undefined ? null : String(metadata.generation)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  },

  async versions({ app, stage }) {
    const key = objectKey(app, stage)
    const bucket = await readStateBucket(clients, project)
    const [files] = await clients.storage.bucket(bucket).getFiles({ prefix: key, versions: true })
    const found: StoredVersion[] = []
    for (const file of files) {
      // A prefix listing, so anything sharing the leading path comes back too.
      if (file.name !== key) continue
      const metadata = file.metadata
      const deleted = metadata.timeDeleted !== undefined
      found.push({
        versionId: String(metadata.generation ?? ''),
        // GCS keeps a noncurrent version rather than writing a tombstone, so a
        // deleted generation is the closest thing to a delete marker.
        type: deleted ? 'delete marker' : 'version',
        lastModified: metadata.updated ? new Date(String(metadata.updated)) : null,
        size: deleted ? null : Number(metadata.size ?? 0),
        storageClass: deleted ? null : ((metadata.storageClass as string | undefined) ?? null),
      })
    }
    return found.sort((left, right) => (right.lastModified?.getTime() ?? 0) - (left.lastModified?.getTime() ?? 0))
  },

  async passphrase({ app, stage }) {
    const name = `projects/${project}/secrets/mstage-passphrase-${app}-${stage}/versions/latest`
    // The value is the same base64 the other backend stores, so either opens an
    // object sealed by the other.
    try {
      return Buffer.from(await secretValue(clients, name), 'base64')
    } catch (error) {
      if (error instanceof EnvError && error.message.endsWith('does not exist')) {
        throw new EnvError(`${name} does not exist, so this store cannot be decrypted`)
      }
      throw error
    }
  },

  state: {
    async readCheckpoint({ app, stage }) {
      const bucket = await readStateBucket(clients, project)
      try {
        const [payload] = await clients.storage.bucket(bucket).file(checkpointKey(app, stage)).download()
        return payload.length === 0 ? null : payload
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async writeCheckpoint({ app, stage, checkpoint }) {
      const bucket = await readStateBucket(clients, project)
      await clients.storage
        .bucket(bucket)
        .file(checkpointKey(app, stage))
        .save(checkpoint, { contentType: 'application/json' })
    },

    async readLock({ app, stage }) {
      const held = await lockFiles(clients, project, app, stage)
      if (held.length === 0) return null
      /*
       * Refused rather than half-answered: each file is one operation holding
       * the stage, so reporting one of two would name a holder nobody asked
       * about and break `state/store.ts`'s check that the lock being dropped is
       * the one that was named. The caller is told how many, not which.
       */
      if (held.length > 1) {
        throw new EnvError(
          `${app}/${stage} has ${held.length} locks, so no single one holds it. ` +
            'Read them in the bucket before dropping any',
        )
      }
      const bucket = await readStateBucket(clients, project)
      try {
        const [payload] = await clients.storage.bucket(bucket).file(held[0]!).download()
        return payload.length === 0 ? null : payload
      } catch (error) {
        // Released between the listing and this read: no lock, which is the
        // answer the caller wanted. Guarded like the reads either side — an
        // unguarded 404 leaves here as a GCS message naming the bucket.
        if (isNotFound(error)) return null
        throw error
      }
    },

    async removeLock({ app, stage }) {
      const bucket = await readStateBucket(clients, project)
      // Every one of them: a stage with any lock file left is a stage the next
      // deploy still refuses, so removing one of two would report success and
      // change nothing a caller can see.
      for (const key of await lockFiles(clients, project, app, stage)) {
        try {
          await clients.storage.bucket(bucket).file(key).delete()
        } catch (error) {
          // A lock released between the listing and here is the outcome asked
          // for, not a failure.
          if (!isNotFound(error)) throw error
        }
      }
    },
  },
})
