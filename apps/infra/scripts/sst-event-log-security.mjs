// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { lstat, mkdir, readlink, readdir, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const PULUMI_EVENT_LOG_NAME = 'eventlog.json'
const POSIX_NULL_DEVICE = '/dev/null'
const FIXED_PULUMI_LOG_NAMES = ['pulumi.log', 'pulumi.err.log']

async function requireRealDirectory(path, label) {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink or another file type`)
    }
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error(`could not create the ${label}`)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink or another file type`)
    }
  }
}

async function removeExactLog(path) {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw new Error('could not inspect an exact SST diagnostic log; refusing to run SST')
  }
  if (metadata.isSymbolicLink()) {
    let target
    try {
      target = await readlink(path)
    } catch {
      throw new Error('could not verify an exact SST diagnostic log symlink; refusing to run SST')
    }
    if (target !== POSIX_NULL_DEVICE) {
      throw new Error('an exact SST diagnostic log points at an unexpected symlink target; refusing to run SST')
    }
  } else if (!metadata.isFile()) {
    throw new Error('an exact SST diagnostic log has an unexpected file type; refusing to run SST')
  }
  try {
    await unlink(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('could not remove an exact SST diagnostic log; refusing to run SST')
  }
}

async function requireNullSink(path) {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('could not inspect a fixed Pulumi log; refusing to run SST')
  }
  if (metadata?.isSymbolicLink()) {
    let target
    try {
      target = await readlink(path)
    } catch {
      throw new Error('could not verify a fixed Pulumi log symlink; refusing to run SST')
    }
    if (target === POSIX_NULL_DEVICE) return
    throw new Error('a fixed Pulumi log points at an unexpected symlink target; refusing to run SST')
  }
  if (metadata) {
    if (!metadata.isFile()) throw new Error('a fixed Pulumi log has an unexpected file type; refusing to run SST')
    try {
      await unlink(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('could not remove a fixed Pulumi log; refusing to run SST')
    }
  }

  try {
    await symlink(POSIX_NULL_DEVICE, path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('could not create a fixed Pulumi null sink; refusing to run SST')
  }
  try {
    const finalMetadata = await lstat(path)
    if (!finalMetadata.isSymbolicLink() || (await readlink(path)) !== POSIX_NULL_DEVICE) {
      throw new Error('fixed Pulumi log null sink verification failed; refusing to run SST')
    }
  } catch (error) {
    if (error.message?.includes('refusing to run SST')) throw error
    throw new Error('fixed Pulumi log null sink verification failed; refusing to run SST')
  }
}

export async function prepareSstLogSecurity(infraRoot) {
  if (process.platform === 'win32') throw new Error('fixed SST log null sinks are not implemented on Windows')
  const sstDirectory = join(infraRoot, '.sst')
  const logDirectory = join(sstDirectory, 'log')
  await requireRealDirectory(sstDirectory, 'SST data directory')
  await requireRealDirectory(logDirectory, 'SST log directory')
  await removeExactLog(join(logDirectory, 'sst.log'))
  for (const name of FIXED_PULUMI_LOG_NAMES) await requireNullSink(join(logDirectory, name))
  return logDirectory
}

export async function withSstLogSecurity(infraRoot, runSstCommand) {
  await prepareSstLogSecurity(infraRoot)
  try {
    return await runSstCommand()
  } finally {
    await prepareSstLogSecurity(infraRoot)
  }
}

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
