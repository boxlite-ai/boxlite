/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Storage } from '@google-cloud/storage'
import { createSnapshotArchiveStore } from './snapshot-archive.store'

const mockBucket = jest.fn()
const mockFile = jest.fn()
const mockDelete = jest.fn()

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: (name: string) => {
      mockBucket(name)
      return {
        file: (key: string) => {
          mockFile(key)
          return { delete: mockDelete }
        },
      }
    },
  })),
}))

function buildStore(values: Record<string, unknown>) {
  return createSnapshotArchiveStore({ get: jest.fn((key: string) => values[key]) } as any)
}

const configured = {
  'boxSnapshot.archivePrefix': 'gs://snapshots/box-snapshots/',
  'gcs.projectId': 'your-first-project',
}

describe('createSnapshotArchiveStore', () => {
  afterEach(() => jest.clearAllMocks())

  it('stays off without an archive prefix', () => {
    expect(buildStore({})).toBeNull()
    expect(Storage).not.toHaveBeenCalled()
  })

  // The reaper retries a delete every tick until it resolves, so an archive
  // that is already gone has to count as deleted.
  it('deletes the object a gs:// URI names, tolerating one already gone', async () => {
    mockDelete.mockResolvedValue(undefined)

    await buildStore(configured)!.delete('gs://snapshots/box-snapshots/org-1/snap-1.boxlite')

    expect(Storage).toHaveBeenCalledWith({ projectId: 'your-first-project' })
    expect(mockBucket).toHaveBeenCalledWith('snapshots')
    expect(mockFile).toHaveBeenCalledWith('box-snapshots/org-1/snap-1.boxlite')
    expect(mockDelete).toHaveBeenCalledWith({ ignoreNotFound: true })
  })

  it.each(['s3://snapshots/key', 'gs://snapshots', 'gs://snapshots/', 'gs:///key', 'box-snapshots/key'])(
    'refuses %s and deletes nothing',
    async (archiveUri) => {
      await expect(buildStore(configured)!.delete(archiveUri)).rejects.toThrow(/Not a Cloud Storage object URI/)
      expect(mockDelete).not.toHaveBeenCalled()
    },
  )
})
