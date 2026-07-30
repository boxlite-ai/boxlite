/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { assertSupportedImage } from '../../box/constants/curated-images.constant'
import { TypedConfigService } from '../typed-config.service'
import { ConfigurationDto } from './configuration.dto'

type ConfigValues = Record<string, unknown>

function configService(overrides: ConfigValues = {}): TypedConfigService {
  const values: ConfigValues = {
    version: '1.2.3',
    'oidc.issuer': 'https://auth.example.com/',
    'oidc.clientId': 'client-id',
    'oidc.audience': 'https://api.example.com',
    'oidc.managementApi.enabled': false,
    'proxy.templateUrl': 'https://{{PORT}}-{{boxId}}.proxy.example.com',
    'proxy.toolboxUrl': 'https://proxy.example.com/toolbox',
    dashboardUrl: 'https://dashboard.example.com',
    maintananceMode: false,
    environment: 'production',
    ...overrides,
  }

  const get = (key: string) => values[key]
  const getOrThrow = (key: string) => {
    const value = values[key]
    if (value === undefined || value === null) throw new Error(`Missing test config: ${key}`)
    return value
  }

  return { get, getOrThrow } as unknown as TypedConfigService
}

describe('ConfigurationDto supported images', () => {
  const previousSystemImages = process.env.BOXLITE_SYSTEM_IMAGES

  afterEach(() => {
    if (previousSystemImages === undefined) delete process.env.BOXLITE_SYSTEM_IMAGES
    else process.env.BOXLITE_SYSTEM_IMAGES = previousSystemImages
  })

  it('exposes operator-added images in the same order and with the same refs as the create allowlist', () => {
    process.env.BOXLITE_SYSTEM_IMAGES =
      'sandbaseai-hermes=sam2026go/hermes-agent:boxlite-noexpose-20260726,custom=ghcr.io/acme/custom:1'

    const dto = new ConfigurationDto(configService(), { endSessionState: 'present' })
    const configuredImages = dto.supportedImages

    expect(configuredImages.map(({ name }) => name)).toEqual(['base', 'python', 'node', 'sandbaseai-hermes', 'custom'])
    expect(configuredImages[3]).toEqual({
      name: 'sandbaseai-hermes',
      ref: 'sam2026go/hermes-agent:boxlite-noexpose-20260726',
    })
    expect(assertSupportedImage('sandbaseai-hermes')).toBe(configuredImages[3].ref)
  })

  it('surfaces the allowlist configuration error instead of returning a partial list', () => {
    process.env.BOXLITE_SYSTEM_IMAGES = 'missing-ref='

    expect(() => new ConfigurationDto(configService(), { endSessionState: 'present' })).toThrow(
      "Invalid BOXLITE_SYSTEM_IMAGES entry 'missing-ref=', expected 'name=ref'",
    )
  })
})
