/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TypedConfigService } from '../typed-config.service'
import { ConfigurationDto } from './configuration.dto'

function configuration(skipUserEmailVerification: boolean): ConfigurationDto {
  const required: Record<string, unknown> = {
    version: 'test',
    'oidc.issuer': 'https://issuer.test',
    'oidc.clientId': 'client',
    'oidc.audience': 'audience',
    'proxy.templateUrl': 'https://proxy.test/{{PORT}}',
    'proxy.toolboxUrl': 'https://proxy.test/toolbox',
    dashboardUrl: 'https://dashboard.test',
    maintananceMode: false,
    environment: 'test',
  }
  const optional: Record<string, unknown> = {
    skipUserEmailVerification,
    'oidc.managementApi.enabled': false,
    rateLimit: { authenticated: {}, boxCreate: {}, boxLifecycle: {} },
  }
  const configService = {
    get: jest.fn((key: string) => optional[key]),
    getOrThrow: jest.fn((key: string) => required[key]),
  } as unknown as TypedConfigService

  return new ConfigurationDto(configService, { endSessionState: 'present' })
}

describe('ConfigurationDto email verification policy', () => {
  it('exposes the required policy to the dashboard', () => {
    expect(configuration(false).oidc.emailVerificationRequired).toBe(true)
    expect(configuration(true).oidc.emailVerificationRequired).toBe(false)
  })
})
