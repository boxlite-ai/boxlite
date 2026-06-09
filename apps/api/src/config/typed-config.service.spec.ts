/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TypedConfigService } from './typed-config.service'

describe('TypedConfigService', () => {
  function buildService(values: Record<string, unknown>) {
    const configService = {
      get: jest.fn((key: string) => values[key]),
    }
    return new TypedConfigService(configService as any)
  }

  it('returns null when ClickHouse is not configured', () => {
    const service = buildService({
      'clickhouse.url': undefined,
      'clickhouse.host': undefined,
    })

    expect(service.getClickHouseConfig()).toBeNull()
  })

  it('uses a full ClickHouse URL when configured', () => {
    const service = buildService({
      'clickhouse.url': 'https://abc123.us-east-1.aws.clickhouse.cloud:8443',
      'clickhouse.host': 'ignored-host',
      'clickhouse.port': 443,
      'clickhouse.protocol': 'https',
      'clickhouse.username': 'reader',
      'clickhouse.password': 'redacted',
      'clickhouse.database': 'otel',
    })

    expect(service.getClickHouseConfig()).toEqual({
      url: 'https://abc123.us-east-1.aws.clickhouse.cloud:8443',
      username: 'reader',
      password: 'redacted',
      database: 'otel',
    })
  })

  it('keeps the existing host, port, and protocol fallback', () => {
    const service = buildService({
      'clickhouse.url': undefined,
      'clickhouse.host': 'abc123.us-east-1.aws.clickhouse.cloud',
      'clickhouse.port': 8443,
      'clickhouse.protocol': 'https',
      'clickhouse.username': 'reader',
      'clickhouse.password': 'redacted',
      'clickhouse.database': 'otel',
    })

    expect(service.getClickHouseConfig()).toEqual({
      url: 'https://abc123.us-east-1.aws.clickhouse.cloud:8443',
      username: 'reader',
      password: 'redacted',
      database: 'otel',
    })
  })
})
