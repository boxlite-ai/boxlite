/*
 * What a cloud has to answer for mstage to keep a stage's configuration in it.
 *
 * Five questions, none mentioning a bucket, a parameter or a secret version:
 * the layout is the backend's business. On AWS it is SST's, because `sst
 * deploy` reads and writes the same objects; elsewhere mstage chooses.
 *
 * `StateObjects` below adds the two objects the deploying engine keeps, grouped
 * separately because they belong to that engine rather than to mstage.
 *
 * Encryption is not a backend's business either: values are sealed before they
 * arrive and opened after they leave, so a backend holds only opaque bytes it
 * must return unchanged.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16

export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/** One stored revision of a stage's object. */
export type StoredVersion = {
  versionId: string
  /** What a store distinguishes: a stored object, or the tombstone hiding it. */
  type: 'version' | 'delete marker'
  lastModified: Date | null
  /** Absent for a delete marker, which holds nothing. */
  size: number | null
  storageClass: string | null
}

/**
 * The two things a deploying engine keeps for a stage beside the store: a
 * checkpoint, and whatever it holds while rewriting one.
 *
 * mstage does not deploy, so it writes neither — it offers only the two repairs
 * a stopped deploy cannot make for itself: dropping a lock the process never
 * released, and editing a checkpoint whose pending operations refuse the next
 * deploy.
 *
 * Says nothing about where either lives, because the engines disagree: SST
 * keeps `app/<app>/<stage>.json` with a `lock/…` object beside it, Pulumi keeps
 * a `.pulumi/` tree with a *directory* of locks. Neither object is sealed here
 * — Pulumi already encrypted what is secret inside the checkpoint.
 */
export type StateObjects = {
  readCheckpoint: (input: { app: string; stage: string }) => Promise<Buffer | null>
  writeCheckpoint: (input: { app: string; stage: string; checkpoint: Buffer }) => Promise<void>
  readLock: (input: { app: string; stage: string }) => Promise<Buffer | null>
  removeLock: (input: { app: string; stage: string }) => Promise<void>
}

/**
 * A place to keep one stage's sealed configuration.
 *
 * `read` returns null for a stage never written — an empty stage is an answer,
 * not a failure — and throws when a named version is gone, because silently
 * returning the newest is the drift pinning exists to prevent.
 */
export type StoreBackend = {
  /** Names the cloud this backend keeps configuration in. */
  readonly home: string
  read: (input: { app: string; stage: string; versionId?: string }) => Promise<Buffer | null>
  write: (input: { app: string; stage: string; sealed: Buffer }) => Promise<void>
  /** The revision a deploy should pin, or null when there is nothing to pin. */
  currentVersion: (input: { app: string; stage: string }) => Promise<string | null>
  versions: (input: { app: string; stage: string }) => Promise<StoredVersion[]>
  /** The key this stage's object is sealed with. Never logged, never returned to a caller. */
  passphrase: (input: { app: string; stage: string }) => Promise<Buffer>
  /**
   * The deployment objects the engine of this home leaves for a stage. Which
   * engine, and therefore which layout, is the backend's own business — SST on
   * AWS, Pulumi on GCP.
   */
  readonly state: StateObjects
}

/**
 * Go writes `nonce || ciphertext || tag` and picks the cipher from the key
 * length, as `aes.NewCipher` does. Identical on both backends, so a store
 * written by one opens with the other and moving a stage is a copy.
 */
const cipherFor = (key: Buffer, where: string): string => {
  const algorithm = { 16: 'aes-128-gcm', 24: 'aes-192-gcm', 32: 'aes-256-gcm' }[key.length]
  if (!algorithm) throw new EnvError(`the passphrase for ${where} is ${key.length} bytes, which is not an AES key size`)
  return algorithm
}

export const seal = (plaintext: string, key: Buffer, where: string): Buffer => {
  const nonce = randomBytes(GCM_NONCE_BYTES)
  const cipher = createCipheriv(cipherFor(key, where) as 'aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export const open = (payload: Buffer, key: Buffer, where: string): string => {
  const algorithm = cipherFor(key, where)
  if (payload.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) throw new EnvError(`${where} is too short to be encrypted`)

  const nonce = payload.subarray(0, GCM_NONCE_BYTES)
  const tag = payload.subarray(payload.length - GCM_TAG_BYTES)
  const body = payload.subarray(GCM_NONCE_BYTES, payload.length - GCM_TAG_BYTES)
  const decipher = createDecipheriv(algorithm as 'aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw new EnvError(`${where} did not decrypt; the passphrase does not match this object`)
  }
}

/** How an object is named, on every backend. Shared so a copy between them is a copy. */
export const objectKey = (app: string, stage: string): string => `secret/${app}/${stage}.json`
