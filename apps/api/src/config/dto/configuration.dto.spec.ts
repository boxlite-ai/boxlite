/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConfigurationDto } from './configuration.dto'
import { TypedConfigService } from '../typed-config.service'

function configServiceFrom(values: Record<string, unknown>): TypedConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key]
      if (value === undefined || value === null) throw new Error(`missing ${key}`)
      return value
    },
  } as unknown as TypedConfigService
}

describe('ConfigurationDto', () => {
  it('exposes the public endpoint contract for dashboard consumers', () => {
    const publicEndpoints = {
      api: {
        canonicalBaseUrl: 'https://api.dev.boxlite.ai',
        legacyBaseUrls: ['https://api.dev.boxlite.ai/api', 'https://dev.boxlite.ai/api'],
      },
      dashboard: {
        canonicalUrl: 'https://dev.boxlite.ai/dashboard',
        legacyUrls: ['https://dev.boxlite.ai'],
      },
    }

    const dto = new ConfigurationDto(
      configServiceFrom({
        version: '0.0.0-test',
        'oidc.issuer': 'https://auth.dev.boxlite.ai',
        'oidc.clientId': 'boxlite',
        'oidc.audience': 'boxlite',
        'oidc.managementApi.enabled': false,
        'proxy.templateUrl': 'https://{{PORT}}-{{boxId}}.proxy.dev.boxlite.ai',
        'proxy.toolboxUrl': 'https://proxy.dev.boxlite.ai/toolbox',
        dashboardUrl: 'https://dev.boxlite.ai',
        maintananceMode: false,
        environment: 'production',
        publicEndpoints,
      }),
      { endSessionState: 'unknown' },
    )

    expect((dto as { publicEndpoints?: unknown }).publicEndpoints).toEqual(publicEndpoints)
  })
})
