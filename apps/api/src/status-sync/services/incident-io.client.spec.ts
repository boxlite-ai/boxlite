/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  },
}))

import axios from 'axios'
import { IncidentIoClient } from './incident-io.client'

const post = axios.post as jest.Mock

const CONFIG: Record<string, unknown> = {
  'incidentIo.apiUrl': 'https://api.incident.test',
  'incidentIo.alertSourceConfigId': 'src-1',
  'incidentIo.heartbeatId': 'hb-1',
  'incidentIo.token': 'tok',
  'incidentIo.timeoutMs': 10_000,
}

const makeClient = (overrides: Record<string, unknown> = {}) => {
  const configService = {
    get: jest.fn((key: string) => {
      const settings = { ...CONFIG, ...overrides }
      if (!(key in settings)) {
        throw new Error(`incident-io.client.spec: unexpected config key "${key}"`)
      }
      return settings[key]
    }),
  }
  return new IncidentIoClient(configService as never)
}

beforeEach(() => {
  post.mockReset()
  post.mockResolvedValue({ status: 202 })
})

describe('IncidentIoClient', () => {
  it('posts alert events to the source endpoint with the wire field names', async () => {
    await makeClient().sendAlertEvent({
      title: 'Boxes degraded (us)',
      status: 'firing',
      deduplicationKey: 'boxlite-prod-boxes-us',
      description: 'Unresponsive runners: 2/5',
      metadata: { component: 'boxes', region: 'us' },
    })

    expect(post).toHaveBeenCalledWith(
      'https://api.incident.test/v2/alert_events/http/src-1',
      {
        title: 'Boxes degraded (us)',
        status: 'firing',
        deduplication_key: 'boxlite-prod-boxes-us',
        description: 'Unresponsive runners: 2/5',
        metadata: { component: 'boxes', region: 'us' },
      },
      {
        timeout: 10_000,
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      },
    )
  })

  it('pings the heartbeat endpoint', async () => {
    await makeClient().pingHeartbeat()

    expect(post).toHaveBeenCalledWith('https://api.incident.test/v2/heartbeat/hb-1/ping', undefined, {
      timeout: 10_000,
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    })
  })

  // The caller owns retry policy; swallowing here would break its damping.
  it('propagates transport failures', async () => {
    post.mockRejectedValue(Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED' }))

    await expect(
      makeClient().sendAlertEvent({
        title: 'API degraded',
        status: 'resolved',
        deduplicationKey: 'boxlite-prod-api',
        description: 'Recovered.',
        metadata: { component: 'api' },
      }),
    ).rejects.toThrow('timeout')
    await expect(makeClient().pingHeartbeat()).rejects.toThrow('timeout')
  })
})
