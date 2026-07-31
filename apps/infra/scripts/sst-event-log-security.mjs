// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const PULUMI_EVENT_LOG_NAME = 'eventlog.json'

/**
 * Remove only Pulumi's transient Automation API event stream files.
 *
 * SST state, checkpoints, and other diagnostics are deliberately retained.
 * Directory symlinks are not followed, so cleanup cannot escape the caller's
 * fixed `.sst/pulumi` root.
 */
export async function removePulumiEventLogs(pulumiRoot) {
  let removedCount = 0

  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw new Error('Unable to inspect Pulumi event logs; refusing to run SST', { cause: error })
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (entry.name !== PULUMI_EVENT_LOG_NAME) continue

      try {
        await unlink(entryPath)
        removedCount += 1
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw new Error('Unable to remove a Pulumi event log; refusing to persist provider credentials', {
          cause: error,
        })
      }
    }
  }

  await visit(pulumiRoot)
  return removedCount
}

/**
 * Clear stale event streams before invoking SST, then clean again regardless
 * of command success. Cleanup errors intentionally fail closed.
 */
export async function withPulumiEventLogCleanup(pulumiRoot, runSstCommand) {
  await removePulumiEventLogs(pulumiRoot)
  try {
    return await runSstCommand()
  } finally {
    await removePulumiEventLogs(pulumiRoot)
  }
}
