/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { incidentIoConfig } from './configuration'

const enabled = (overrides: Record<string, string> = {}) => ({
  STATUS_SYNC_ENABLED: 'true',
  INCIDENT_IO_TOKEN: 'tok',
  INCIDENT_IO_ALERT_SOURCE_CONFIG_ID: 'src-1',
  ...overrides,
})

describe('incidentIoConfig', () => {
  it('defaults to disabled and demands nothing', () => {
    expect(incidentIoConfig({})).toEqual({
      enabled: false,
      token: undefined,
      alertSourceConfigId: undefined,
      heartbeatId: undefined,
      dedupPrefix: 'boxlite-dev',
      apiUrl: 'https://api.incident.io',
      timeoutMs: 10_000,
      probeTimeoutMs: 5_000,
    })
  })

  // Enabled without credentials would push every tick into a 401 and page
  // nobody — a silent stall dressed up as delivery failure.
  it.each([
    [
      'no token',
      { STATUS_SYNC_ENABLED: 'true', INCIDENT_IO_ALERT_SOURCE_CONFIG_ID: 'src-1' },
      /INCIDENT_IO_TOKEN is required/,
    ],
    ['a blank token', enabled({ INCIDENT_IO_TOKEN: '  ' }), /INCIDENT_IO_TOKEN is required/],
    [
      'no source id',
      { STATUS_SYNC_ENABLED: 'true', INCIDENT_IO_TOKEN: 'tok' },
      /INCIDENT_IO_ALERT_SOURCE_CONFIG_ID is required/,
    ],
    [
      'a blank source id',
      enabled({ INCIDENT_IO_ALERT_SOURCE_CONFIG_ID: '' }),
      /INCIDENT_IO_ALERT_SOURCE_CONFIG_ID is required/,
    ],
  ])('refuses to start when sync is enabled with %s', (_case, environment, expected) => {
    expect(() => incidentIoConfig(environment)).toThrow(expected)
  })

  it('accepts a fully configured sync', () => {
    expect(incidentIoConfig(enabled({ INCIDENT_IO_HEARTBEAT_ID: 'hb-1' }))).toEqual(
      expect.objectContaining({ enabled: true, token: 'tok', alertSourceConfigId: 'src-1', heartbeatId: 'hb-1' }),
    )
  })

  it('treats the heartbeat as optional even when enabled', () => {
    expect(incidentIoConfig(enabled()).heartbeatId).toBeUndefined()
  })

  // The prefix leads every deduplication key; a capital or space would fork
  // new alert identities on the incident.io side instead of updating them.
  it.each([
    ['a capital', 'Boxlite-Prod'],
    ['a space', 'boxlite prod'],
    ['a leading dash', '-boxlite'],
  ])('rejects %s in the dedup prefix when enabled', (_case, value) => {
    expect(() => incidentIoConfig(enabled({ STATUS_SYNC_DEDUP_PREFIX: value }))).toThrow(
      /STATUS_SYNC_DEDUP_PREFIX must be a lowercase slug/,
    )
  })

  it('derives the default prefix from ENVIRONMENT', () => {
    expect(incidentIoConfig({ ENVIRONMENT: 'production' }).dedupPrefix).toBe('boxlite-production')
    expect(incidentIoConfig(enabled({ STATUS_SYNC_DEDUP_PREFIX: 'boxlite-prod' })).dedupPrefix).toBe('boxlite-prod')
  })

  // Counts are malformed in every state — rejecting them costs a disabled
  // stage nothing it could legitimately have wanted.
  it.each([
    ['INCIDENT_IO_TIMEOUT_MS', { INCIDENT_IO_TIMEOUT_MS: '1e9' }],
    ['STATUS_SYNC_PROBE_TIMEOUT_MS', { STATUS_SYNC_PROBE_TIMEOUT_MS: 'abc' }],
  ])('rejects a malformed %s even when disabled', (name, environment) => {
    expect(() => incidentIoConfig(environment)).toThrow(new RegExp(`${name} must be a whole number`))
  })

  it.each([
    ['a bare hostname', 'api.incident.test.invalid'],
    ['a non-http scheme', 'ftp://api.incident.io'],
    ['a query string', 'https://api.incident.io?x=1'],
    // The token rides this URL as a bearer header; http would leak it.
    ['plain http', 'http://api.incident.io'],
  ])('rejects %s as the API URL when enabled', (_case, value) => {
    expect(() => incidentIoConfig(enabled({ INCIDENT_IO_API_URL: value }))).toThrow(/INCIDENT_IO_API_URL/)
  })

  it('strips trailing slashes from the API URL', () => {
    expect(incidentIoConfig(enabled({ INCIDENT_IO_API_URL: 'https://api.incident.io/' })).apiUrl).toBe(
      'https://api.incident.io',
    )
  })
})
