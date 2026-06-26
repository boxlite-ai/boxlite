/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BOX_CREATE_SECRETS_TTL_SECONDS, boxCreateSecretsKey } from '../utils/box-create-secrets.util'

describe('BoxService secret handling', () => {
  it('stores create-box secret values encrypted in Redis for create retries', async () => {
    const service = Object.create(BoxService.prototype) as BoxService
    ;(service as any).encryptionService = {
      encrypt: jest.fn(async (value: string) => `encrypted:${value}`),
    }
    ;(service as any).redis = {
      set: jest.fn(async () => 'OK'),
    }

    await (service as any).storeCreateSecrets('box-1', [
      {
        name: 'openai_api_key',
        value: 'sk-test',
        hosts: ['api.openai.com'],
        placeholder: '<BOXLITE_SECRET:openai_api_key>',
      },
    ])

    expect((service as any).redis.set).toHaveBeenCalledWith(
      boxCreateSecretsKey('box-1'),
      JSON.stringify([
        {
          name: 'openai_api_key',
          value: 'encrypted:sk-test',
          hosts: ['api.openai.com'],
          placeholder: '<BOXLITE_SECRET:openai_api_key>',
        },
      ]),
      'EX',
      BOX_CREATE_SECRETS_TTL_SECONDS,
    )
    expect((service as any).encryptionService.encrypt).toHaveBeenCalledWith('sk-test')
  })
})
