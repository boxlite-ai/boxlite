// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { ConfigService } from '@nestjs/config'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { CheckpointArchiveStore } from './checkpoint-archive.store'
import { Checkpoint } from '../entities/checkpoint.entity'
import { checkpointConfig } from '../../config/checkpoint-config'

describe('S3 checkpoint deletion', () => {
  const configuration = checkpointConfig({
    CHECKPOINT_ARCHIVE_PREFIX: 's3://checkpoint-tests/checkpoints/',
    CHECKPOINTS_ENABLED: 'true',
  })
  const checkpoint = {
    organizationId: 'organization',
    id: 'checkpoint',
    arcPath: 's3://checkpoint-tests/checkpoints/organization/checkpoint/archive.boxlite',
  } as Checkpoint
  const setup = () => {
    const send = jest.fn().mockResolvedValue({})
    const store = new CheckpointArchiveStore({ get: () => configuration } as unknown as ConfigService, {
      s3: { send } as any,
    })
    return { send, store }
  }
  it('deletes the exact object admitted by S3 configuration', async () => {
    const { send, store } = setup()
    expect(configuration.enabled).toBe(true)
    await store.remove(checkpoint)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand)
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'checkpoint-tests',
      Key: 'checkpoints/organization/checkpoint/archive.boxlite',
    })
  })
  it('rejects another tenant, bucket, checkpoint or provider before S3 access', async () => {
    const { send, store } = setup()
    for (const value of [
      { ...checkpoint, organizationId: 'another' },
      { ...checkpoint, id: 'another' },
      { ...checkpoint, arcPath: checkpoint.arcPath.replace('checkpoint-tests', 'another-bucket') },
      { ...checkpoint, arcPath: checkpoint.arcPath.replace('s3://', 'gs://') },
    ])
      await expect(store.remove(value)).rejects.toMatchObject({ status: 503 })
    expect(send).not.toHaveBeenCalled()
  })
  it('returns retryable failure while keeping object locations out of its public error', async () => {
    const { send, store } = setup()
    send.mockRejectedValue(new Error(checkpoint.arcPath))
    const error = await store.remove(checkpoint).catch((error) => error)
    expect(error.getStatus()).toBe(503)
    expect(JSON.stringify(error.getResponse())).not.toContain('s3://')
  })
})
