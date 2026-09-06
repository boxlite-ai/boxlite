/*
 * What a stopped deploy leaves behind, and the two things that can be done to it.
 *
 * A deploy takes a lock, rewrites the checkpoint as it goes, and drops the lock
 * on its way out. A deploy that is killed — a cancelled workflow, a closed
 * laptop — never reaches the last step, so the lock stays and the operations it
 * was in the middle of stay recorded as pending. The next deploy then refuses:
 * once because the stage looks busy, and once because Pulumi will not plan over
 * operations whose outcome nobody observed.
 *
 * Both are repairs to objects rather than to infrastructure, which is why they
 * live here and not in whatever deploys. mstage already reads and writes this
 * bucket for the stage environment; these are two more keys in it.
 *
 * Removing a pending operation is not the same as knowing what happened to the
 * resource it names. The operation was interrupted, so the cloud may hold a
 * resource the checkpoint does not, or the reverse. Editing the record is how a
 * stage becomes deployable again; a refresh is how it becomes accurate, and the
 * order is that one first.
 */

import type { StateObjects, StoreBackend } from '../env/backend.ts'

export class StateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateError'
  }
}

/** What SST records for whoever holds the lock (`lockData`, pkg/project/provider/provider.go). */
export type StageLock = {
  created: string | null
  updateID: string | null
  runID: string | null
  command: string | null
}

type Stage = { backend: StoreBackend; app: string; stage: string }

const objectsOf = (backend: StoreBackend): StateObjects => {
  if (!backend.state) {
    throw new StateError(
      `Nothing deploys into a "${backend.home}" home, so it keeps no deployment state to unlock or edit`,
    )
  }
  return backend.state
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

/**
 * Who holds the lock, or null when nobody does.
 *
 * A lock that does not parse is still a lock, and the whole reason to look at
 * one is usually that it should not be there — so the fields are best effort and
 * an unreadable one comes back with all of them empty rather than as a failure
 * that would also block removing it.
 */
export const readLock = async ({ backend, app, stage }: Stage): Promise<StageLock | null> => {
  const payload = await objectsOf(backend).readLock({ app, stage })
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
  }
}

/** Who is being interrupted. A lock a deploy still holds is not a stale one. */
export const describeLock = ({ app, stage, lock }: { app: string; stage: string; lock: StageLock }): string =>
  [
    `${app}/${stage} is locked by ${lock.command ?? 'an unrecorded command'}`,
    lock.runID ? ` in run ${lock.runID}` : '',
    lock.updateID ? `, update ${lock.updateID}` : '',
    lock.created ? `, since ${lock.created}` : '',
  ].join('')

const sameLock = (left: StageLock, right: StageLock): boolean =>
  left.created === right.created &&
  left.updateID === right.updateID &&
  left.runID === right.runID &&
  left.command === right.command

/**
 * Removes the lock that was named, and only that one.
 *
 * Naming a lock and dropping it are two calls, and a deploy can take the lock in
 * between — which would report a lock from last week and delete a live one. So
 * the lock is read again and compared, the same way a checkpoint write compares
 * before it lands. Returns whether there was still one to remove: a lock that
 * went on its own leaves the stage in the state the caller asked for.
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
  await objectsOf(backend).removeLock({ app, stage })
  return true
}

/** The checkpoint as stored. A stage nothing has ever deployed into has none. */
export const readCheckpoint = async ({ backend, app, stage }: Stage): Promise<Buffer> => {
  const payload = await objectsOf(backend).readCheckpoint({ app, stage })
  if (!payload) throw new StateError(`${app}/${stage} has no deployment state; nothing has been deployed into it`)
  return payload
}

/** What SST stores: a versioned Pulumi checkpoint (`Import`, pkg/project/workdir.go). */
type VersionedCheckpoint = { checkpoint?: { latest?: { pending_operations?: unknown[] } | null } }

/** The one SST 3.19.3 writes, and the one every key in this backend belongs to. */
const CHECKPOINT_VERSION = 3

const isObject = (value: unknown): boolean => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * The whole wrapper, or nothing.
 *
 * Both fields are checked because both are load-bearing: the version is what
 * says which reader opens it, and a `checkpoint` that is null, a string or
 * absent describes a stage with no resources rather than a stage as it is.
 * Accepting any of those would store a file that parses and still loses
 * everything the stage had.
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
 * How many operations were in flight when the deploy that wrote this stopped,
 * or null when these bytes are not a checkpoint at all.
 *
 * Null is worth telling apart from zero: a stage whose state no longer parses is
 * stuck for a different reason and needs a different edit.
 */
export const pendingOperations = (checkpoint: Buffer): number | null => {
  const parsed = parse(checkpoint)
  if (!parsed) return null
  const pending = parsed.checkpoint?.latest?.pending_operations
  return Array.isArray(pending) ? pending.length : 0
}

/**
 * Replaces the checkpoint, once it still is one and once nothing else has moved.
 *
 * Three refusals, because a write here has no undo. The next deploy is what
 * reads these bytes back, so a file that stopped parsing or lost its wrapper to
 * a stray keystroke would leave a stage that neither a deploy nor a second edit
 * can open. And an edit is a read-modify-write held open for as long as someone
 * leaves an editor sitting there, so `replacing` — the bytes that editor was
 * given — is compared against what is stored now: a deploy that took the lock,
 * or wrote at all, in the meantime would otherwise be overwritten by a file
 * that predates it.
 *
 * The comparison is not atomic and does not pretend to be. It closes the window
 * that is minutes long and leaves the one that is milliseconds long.
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
      `That is not a checkpoint: SST stores {"version":3,"checkpoint":{…}}, so ${app}/${stage} was left as it was`,
    )
  }
  const lock = await readLock({ backend, app, stage })
  if (lock) {
    throw new StateError(
      `${describeLock({ app, stage, lock })}, which happened while this was open. Nothing was written`,
    )
  }
  const current = await objectsOf(backend).readCheckpoint({ app, stage })
  if (!current || !current.equals(replacing)) {
    throw new StateError(`${app}/${stage} was rewritten while this was open. Nothing was written`)
  }
  await objectsOf(backend).writeCheckpoint({ app, stage, checkpoint })
}
