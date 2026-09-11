/*
 * What a stopped deploy leaves behind, and the two things that can be done to it.
 *
 * A deploy takes a lock, rewrites the checkpoint, and drops the lock on its way
 * out. A killed deploy never reaches the last step, so the lock stays and its
 * operations stay pending — and the next deploy refuses twice: the stage looks
 * busy, and Pulumi will not plan over operations nobody observed.
 *
 * Both are repairs to objects rather than infrastructure, which is why they
 * live here: mstage already reads this bucket for the stage environment.
 *
 * Removing a pending operation is not knowing what happened to the resource it
 * names. Editing the record makes a stage deployable again; a refresh makes it
 * accurate, in that order.
 */

import { createHash } from 'node:crypto'
import type { StoreBackend } from '../env/backend.ts'

export class StateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateError'
  }
}

/**
 * Whoever holds the lock, as much as the engine that took it recorded. Two
 * disjoint sets: SST says what was running, Pulumi says who ran it, and a lock
 * carries one or the other.
 */
export type StageLock = {
  /** SST's (`lockData`, pkg/project/provider/provider.go). */
  created: string | null
  updateID: string | null
  runID: string | null
  command: string | null
  /** Pulumi's (`lockContent`, pkg/backend/diy/lock.go). */
  username: string | null
  hostname: string | null
  pid: number | null
  timestamp: string | null
  /**
   * What tells one lock from another, whatever engine wrote it. Neither field
   * set can: an unrecognised engine leaves them all null, making any two such
   * locks equal. A digest of the bytes is the identity every engine has.
   */
  identity: string
}

type Stage = { backend: StoreBackend; app: string; stage: string }

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/**
 * Who holds the lock, or null when nobody does. A lock that does not parse is
 * still a lock, so the fields are best effort: an unreadable one comes back
 * empty rather than as a failure that would also block removing it.
 */
export const readLock = async ({ backend, app, stage }: Stage): Promise<StageLock | null> => {
  const payload = await backend.state.readLock({ app, stage })
  if (!payload) return null
  let held: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(payload.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) held = parsed as Record<string, unknown>
  } catch {
    // Described below as an unknown holder, which is all this needs to say.
  }
  return {
    created: text(held.created),
    updateID: text(held.updateID),
    runID: text(held.runID),
    command: text(held.command),
    username: text(held.username),
    hostname: text(held.hostname),
    pid: typeof held.pid === 'number' ? held.pid : null,
    timestamp: text(held.timestamp),
    identity: createHash('sha256').update(payload).digest('hex'),
  }
}

/**
 * Who is being interrupted — the whole basis for telling a stale lock from a
 * live one. Reads both field sets, or every lock the other engine took would
 * render as "an unrecorded command".
 */
export const describeLock = ({ app, stage, lock }: { app: string; stage: string; lock: StageLock }): string =>
  [
    `${app}/${stage} is locked by ${holderOf(lock)}`,
    lock.runID ? ` in run ${lock.runID}` : '',
    lock.updateID ? `, update ${lock.updateID}` : '',
    lock.pid === null ? '' : `, pid ${lock.pid}`,
    lock.created ?? lock.timestamp ? `, since ${lock.created ?? lock.timestamp}` : '',
  ].join('')

/** What SST calls a command, Pulumi calls a person on a machine. */
const holderOf = (lock: StageLock): string => {
  if (lock.command) return lock.command
  if (lock.username) return lock.hostname ? `${lock.username} on ${lock.hostname}` : lock.username
  return 'an unrecorded command'
}

/** The bytes, not the fields: an engine whose fields this cannot read still has bytes. */
const sameLock = (left: StageLock, right: StageLock): boolean => left.identity === right.identity

/**
 * Removes the lock that was named, and only that one.
 *
 * Naming and dropping are two calls, and a deploy can take the lock in between
 * — reporting last week's lock and deleting a live one. So it is read again and
 * compared. Returns whether there was still one to remove.
 */
export const clearLock = async ({
  backend,
  app,
  stage,
  replacing,
}: Stage & { replacing: StageLock }): Promise<boolean> => {
  const held = await readLock({ backend, app, stage })
  if (!held) return false
  if (!sameLock(held, replacing)) {
    throw new StateError(
      `${describeLock({ app, stage, lock: held })}, which is not the lock that was just reported. Nothing was removed`,
    )
  }
  await backend.state.removeLock({ app, stage })
  return true
}

/** The checkpoint as stored. A stage nothing has ever deployed into has none. */
export const readCheckpoint = async ({ backend, app, stage }: Stage): Promise<Buffer> => {
  const payload = await backend.state.readCheckpoint({ app, stage })
  if (!payload) throw new StateError(`${app}/${stage} has no deployment state; nothing has been deployed into it`)
  return payload
}

/**
 * A versioned Pulumi checkpoint — what SST stores (`Import`,
 * pkg/project/workdir.go) and what Pulumi's own backend stores directly.
 */
type VersionedCheckpoint = { checkpoint?: { latest?: { pending_operations?: unknown[] } | null } }

/**
 * The version both engines write today, and the only one this opens.
 *
 * `apitype.DeploymentSchemaVersionCurrent` is 3 unless a stack uses a v4
 * feature. A v4 checkpoint is refused rather than edited: this writes the whole
 * file back, so opening a shape it does not understand is how a stage loses
 * everything. Raising this means reading what v4 changed.
 */
const CHECKPOINT_VERSION = 3

const isObject = (value: unknown): boolean => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * The whole wrapper, or nothing. The version says which reader opens it, and a
 * `checkpoint` that is null, a string or absent describes an empty stage —
 * accepting either would store a file that parses and loses everything.
 */
const parse = (checkpoint: Buffer): VersionedCheckpoint | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(checkpoint.toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const wrapper = parsed as { version?: unknown; checkpoint?: unknown }
  if (wrapper.version !== CHECKPOINT_VERSION || !isObject(wrapper.checkpoint)) return null
  return wrapper as VersionedCheckpoint
}

/**
 * How many operations were in flight when the deploy stopped, or null when
 * these bytes are not a checkpoint — a stage whose state no longer parses is
 * stuck for a different reason and needs a different edit.
 */
export const pendingOperations = (checkpoint: Buffer): number | null => {
  const parsed = parse(checkpoint)
  if (!parsed) return null
  const pending = parsed.checkpoint?.latest?.pending_operations
  return Array.isArray(pending) ? pending.length : 0
}

/**
 * Replaces the checkpoint, once it still is one and nothing else has moved.
 *
 * Three refusals, because this write has no undo: a file that stopped parsing
 * or lost its wrapper leaves a stage neither a deploy nor a second edit can
 * open. And since an edit stays open as long as the editor does, `replacing` is
 * compared against what is stored now, or a deploy that landed meanwhile would
 * be overwritten by a file that predates it.
 *
 * Not atomic, and does not pretend to be: it closes the window that is minutes
 * long and leaves the one that is milliseconds long.
 */
export const writeCheckpoint = async ({
  backend,
  app,
  stage,
  checkpoint,
  replacing,
}: Stage & { checkpoint: Buffer; replacing: Buffer }): Promise<void> => {
  if (!parse(checkpoint)) {
    throw new StateError(
      `That is not a checkpoint this reader opens: it stores {"version":3,"checkpoint":{…}}, ` +
        `so ${app}/${stage} was left as it was`,
    )
  }
  const lock = await readLock({ backend, app, stage })
  if (lock) {
    throw new StateError(
      `${describeLock({ app, stage, lock })}, which happened while this was open. Nothing was written`,
    )
  }
  const current = await backend.state.readCheckpoint({ app, stage })
  if (!current || !current.equals(replacing)) {
    throw new StateError(`${app}/${stage} was rewritten while this was open. Nothing was written`)
  }
  await backend.state.writeCheckpoint({ app, stage, checkpoint })
}
