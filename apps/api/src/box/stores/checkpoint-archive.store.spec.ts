// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { ConfigService } from '@nestjs/config'
import { Storage } from '@google-cloud/storage'
import { CheckpointArchiveStore } from './checkpoint-archive.store'
import { Checkpoint } from '../entities/checkpoint.entity'

jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }))

describe('Checkpoint archive deletion boundary', () => {
  const remove = jest.fn()
  const file = jest.fn(() => ({ delete: remove }))
  const bucket = jest.fn(() => ({ file }))
  const checkpoint = {
    organizationId: 'organization',
    id: 'checkpoint',
    arcPath: 'gs://checkpoint-tests/checkpoints/organization/checkpoint/archive.boxlite',
  } as Checkpoint
  let store: CheckpointArchiveStore

  beforeEach(() => {
    jest.clearAllMocks()
    remove.mockReset().mockResolvedValue(undefined)
    ;(Storage as unknown as jest.Mock).mockImplementation(() => ({ bucket }))
    store = new CheckpointArchiveStore({
      get: () => ({ archivePrefix: 'gs://checkpoint-tests/checkpoints/' }),
    } as unknown as ConfigService)
  })

  it('deletes the exact configured object and treats an already absent object as success', async () => {
    await store.remove(checkpoint)
    expect(bucket).toHaveBeenCalledWith('checkpoint-tests')
    expect(file).toHaveBeenCalledWith('checkpoints/organization/checkpoint/archive.boxlite')
    expect(remove).toHaveBeenCalledWith({ ignoreNotFound: true })
  })

  it('refuses mismatched tenant, checkpoint, prefix and scheme before object access', async () => {
    for (const value of [
      { ...checkpoint, organizationId: 'other' },
      { ...checkpoint, id: 'other' },
      { ...checkpoint, arcPath: checkpoint.arcPath.replace('checkpoint-tests', 'another-bucket') },
      { ...checkpoint, arcPath: 'https://example.invalid/archive.boxlite' },
    ])
      await expect(store.remove(value)).rejects.toMatchObject({ status: 503 })
    expect(bucket).not.toHaveBeenCalled()
  })

  it('returns a retryable failure without exposing internal object locations', async () => {
    remove.mockRejectedValue(new Error(checkpoint.arcPath))
    const error = await store.remove(checkpoint).catch((error) => error)
    expect(error.getStatus()).toBe(503)
    expect(JSON.stringify(error.getResponse())).not.toContain('gs://')
  })
})
