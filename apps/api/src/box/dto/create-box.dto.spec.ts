/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateBoxDto } from './create-box.dto'

describe('CreateBoxDto managed volumes', () => {
  it.each([
    ['non-string volumeId', { volumeId: 1, mountPath: '/data' }],
    ['non-string mountPath', { volumeId: 'vol-1', mountPath: 1 }],
    ['non-string subpath', { volumeId: 'vol-1', mountPath: '/data', subpath: 1 }],
    ['non-boolean readOnly', { volumeId: 'vol-1', mountPath: '/data', readOnly: 'true' }],
  ])('rejects %s at the nested DTO boundary', async (_label, volume) => {
    const errors = await validate(plainToInstance(CreateBoxDto, { volumes: [volume] }))
    expect(errors.length).toBeGreaterThan(0)
  })

  it('accepts the cloud-native whole-volume empty subpath', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        volumes: [{ volumeId: 'vol-1', mountPath: '/data', subpath: '', readOnly: false }],
      }),
    )
    expect(errors).toHaveLength(0)
  })
})
