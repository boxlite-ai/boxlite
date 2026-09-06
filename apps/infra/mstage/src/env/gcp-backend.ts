/*
 * The store on GCP: one bucket, one secret per stage.
 *
 * Unlike the AWS backend this one is not copying anyone. No deploy tool reads
 * these objects, so the layout is mstage's own and is chosen to be boring:
 *
 *   Secret Manager  mstage-bootstrap                   which bucket holds the store
 *   GCS             secret/<app>/<stage>.json          the sealed map
 *   Secret Manager  mstage-passphrase-<app>-<stage>    the key
 *
 * The bucket is discovered rather than passed, the same way AWS reads
 * `/sst/bootstrap`. Not for obscurity — IAM is the boundary either way — but so
 * that moving the store to another bucket is one edit to one record instead of
 * an edit everywhere a caller constructs a backend. The record has the same
 * shape on both clouds, `{"state": "<bucket>"}`, so the two lookups read alike.
 *
 * Object versions are generation numbers, which GCS returns as integers. They
 * are carried as strings so a pinned version means the same thing to a caller on
 * either cloud.
 */

import { EnvError, objectKey, type StoreBackend, type StoredVersion } from './backend.ts'

/**
 * The two Google clients this needs, in the shape their SDKs already have.
 * Structural rather than imported so nothing here depends on the packages
 * being installed until a GCP stage actually exists.
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
      }
      getFiles: (options: {
        prefix: string
        versions: boolean
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
 * Which bucket holds the store, for this project.
 *
 * The GCP counterpart of `/sst/bootstrap`. One record, read once per call, so
 * pointing the store at a different bucket is an edit to that record and
 * nothing else.
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

  // Nothing deploys into this home. `sst deploy` writes its checkpoint and takes
  // its lock on AWS, so there is no checkpoint here to repair and no lock to drop,
  // and inventing a layout for objects nothing writes would only make `mstage
  // state` answer about a stage it cannot see.
  state: null,
})
