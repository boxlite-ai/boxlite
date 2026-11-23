/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { AnalyticsConsentService } from './analytics-consent.service'
import { AnalyticsService } from './analytics.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { recordBusinessEvent } from '../../common/utils/business-event.util'

it('sends no analytics request for an organization without a creator grant', async () => {
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.writeHead(200).end('{"status":1}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const config: Record<string, string> = {
      'posthog.apiKey': 'phc_test',
      'posthog.host': 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    }
    const denied = Object.create(AnalyticsConsentService.prototype) as AnalyticsConsentService
    jest.spyOn(denied, 'dispatch').mockResolvedValue(false)
    const analytics = new AnalyticsService({ get: (key: string) => config[key] } as TypedConfigService, denied)
    recordBusinessEvent({ name: 'box.open', outcome: 'success', correlationId: 'box', organizationId: 'org' })
    await analytics.onApplicationShutdown()
    expect(requests).toBe(0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
