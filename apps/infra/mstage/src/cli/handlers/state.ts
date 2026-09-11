/**
 * `mstage state` — the two repairs a stage needs after a deploy stops halfway.
 *
 * Both are the engine's own — `sst unlock` and `sst state edit` on AWS, the
 * equivalent Pulumi repairs on GCP — done against the bucket rather than
 * through either CLI, because both CLIs need a stack config and which stack
 * this repository deploys is mdeploy's business.
 *
 * mstage adds the rest of a stage around them: the region, the credentials, and
 * the refusal to touch a protected stage without --confirm.
 *
 * It adds no lock of its own. `edit` is for a stage nothing is deploying into:
 * it refuses to open while a lock is held, and refuses to write if a lock was
 * taken or the checkpoint moved meanwhile. Narrower than holding the lock, but
 * it covers the window that is minutes long.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChild } from '../../aws/child-env.ts'
import {
  StateError,
  clearLock,
  describeLock,
  pendingOperations,
  readCheckpoint,
  readLock,
  writeCheckpoint,
} from '../../state/store.ts'
import type { StoreBackend } from '../../env/backend.ts'
import type { Scope } from '../../aws/precedence.ts'

type Log = (line: string) => void

type Input = {
  scope: Scope
  options: Record<string, string | boolean>
  log: Log
  /** The store this stage lives in. Resolved once, by `resolveHome`. */
  backend: StoreBackend
}

const refuseProtected = (scope: Scope, options: Input['options'], what: string): void => {
  if (scope.protect && options.confirm !== true) {
    throw new StateError(`Stage "${scope.stage}" is protected; add --confirm to ${what}`)
  }
}

/**
 * `mstage state unlock` — drops the lock a deploy did not live to release.
 *
 * What held it is printed first, because this cannot tell whether that deploy
 * is still running, and a lock removed under a live one lets a second start
 * against the same checkpoint. The operator gets what the engine recorded and
 * makes that call.
 */
export const unlock = async ({ scope, options, log, backend }: Input): Promise<number> => {
  refuseProtected(scope, options, 'drop its lock')

  const app = scope.app as string
  const stage = scope.stage as string
  const lock = await readLock({ backend, app, stage })
  if (!lock) {
    // Not an error: the caller asked for the lock to be gone, and it is.
    log(`# ${app}/${stage} holds no lock`)
    return 0
  }
  log(describeLock({ app, stage, lock }))
  const removed = await clearLock({ backend, app, stage, replacing: lock })
  log(removed ? `lock removed from ${app}/${stage}` : `# that lock went before it could be removed`)
  return 0
}

/**
 * What opens the file. `EDITOR` is a command line rather than a program name —
 * `code -w`, `subl -w` — so it is split the way a shell would. The fallback is
 * vim, which is SST's (cmd/sst/state.go).
 */
export const editorCommand = (environment: NodeJS.ProcessEnv): [string, ...string[]] => {
  const [program, ...arguments_] = (environment.EDITOR ?? '').trim().split(/\s+/).filter(Boolean)
  return program ? [program, ...arguments_] : ['vim']
}

/**
 * `mstage state edit` — the checkpoint itself, in an editor.
 *
 * The escape hatch for a state no deploy will accept; pending operations are
 * the usual reason, and deleting them from `checkpoint.latest.pending_operations`
 * lets the next deploy plan again. How many there are is printed first.
 *
 * The copy goes to a private temporary directory and is removed once the write
 * lands. A refused write keeps it and says where — that copy is the only place
 * the operator's edit exists.
 */
export const edit = async ({
  scope,
  options,
  log,
  backend,
  environment = process.env,
  spawnProcess = spawn,
}: Input & { environment?: NodeJS.ProcessEnv; spawnProcess?: typeof spawn }): Promise<number> => {
  refuseProtected(scope, options, 'edit its state')

  const app = scope.app as string
  const stage = scope.stage as string
  // A lock means something may be deploying into this checkpoint right now, and
  // an edit under one is how two writers end up with one file between them.
  const lock = await readLock({ backend, app, stage })
  if (lock) {
    throw new StateError(
      `${describeLock({ app, stage, lock })}. An edit would be overwritten by that deploy, or overwrite it. ` +
        `If it is gone, drop the lock first: npm run mstage state unlock -- --stage ${stage}`,
    )
  }

  const stored = await readCheckpoint({ backend, app, stage })
  const pending = pendingOperations(stored)
  if (pending === null) log(`# this state does not parse as a checkpoint, which is itself enough to stop a deploy`)
  else if (pending > 0) log(`# ${pending} pending operation${pending === 1 ? '' : 's'} in checkpoint.latest`)

  const workspace = await mkdtemp(join(tmpdir(), 'mstage-state-'))
  const file = join(workspace, `${stage}.json`)
  let settled = false
  try {
    await writeFile(file, stored, { mode: 0o600 })
    const [command, ...args] = editorCommand(environment)
    await runChild({ command, args: [...args, file], env: environment, spawnProcess })

    const edited = await readFile(file)
    if (edited.equals(stored)) {
      log(`# ${app}/${stage} is unchanged; nothing was written`)
    } else {
      await writeCheckpoint({ backend, app, stage, checkpoint: edited, replacing: stored })
      log(`state written for ${app}/${stage}`)
      // Said every time, because the edit only makes the stage deployable. What
      // the interrupted operations left in the cloud is still unobserved, and a
      // refresh before the next deploy is what reconciles it.
      log('# the record is deployable again; a refresh is what makes it true')
    }
    settled = true
  } finally {
    if (settled) await rm(workspace, { recursive: true, force: true })
    else log(`# the edited state is kept at ${file}`)
  }
  return 0
}
