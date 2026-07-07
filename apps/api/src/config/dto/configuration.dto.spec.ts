/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConfigurationDto } from './configuration.dto'

function buildConfigService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    version: '0.1.0',
    'oidc.issuer': 'https://issuer.example.com',
    'oidc.clientId': 'client-id',
    'oidc.audience': 'https://dev.boxlite.ai/api',
    'oidc.managementApi.enabled': false,
    'proxy.templateUrl': 'https://proxy.dev.boxlite.ai',
    'proxy.toolboxUrl': 'https://proxy.dev.boxlite.ai/toolbox',
    dashboardUrl: 'https://dev.boxlite.ai',
    maintananceMode: false,
    environment: 'production',
    'urls.publicRestApiUrl': 'https://dev.boxlite.ai/api',
    'urls.dashboardApiUrl': 'https://dev.boxlite.ai/api',
    ...overrides,
  }

  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key]
      if (value === undefined) {
        throw new Error(`missing config ${key}`)
      }
      return value
    }),
  }
}

describe('ConfigurationDto', () => {
  it('exposes the URL contract used by dashboard quickstarts and runtime diagnostics', () => {
    const dto = new ConfigurationDto(buildConfigService() as any, { endSessionState: 'present' })

    expect(dto.urls).toEqual({
      publicRestApiUrl: 'https://dev.boxlite.ai/api',
      dashboardApiUrl: 'https://dev.boxlite.ai/api',
    })
  })
})
