/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { OpenFeaturePostHogProvider } from './openfeature-posthog.provider'
import { AnalyticsConsentService } from '../../analytics/services/analytics-consent.service'
import { AnalyticsService } from '../../analytics/services/analytics.service'
import { TypedConfigService } from '../../config/typed-config.service'

it('evaluates identified rollouts after refusal without ingesting an exposure event', async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  let enabled = true
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url!.split('?')[0], body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ featureFlags: { rollout: enabled }, featureFlagPayloads: {} }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const host = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const config: Record<string, string> = { 'posthog.apiKey': 'phc_test', 'posthog.host': host }
  const consent = Object.create(AnalyticsConsentService.prototype) as AnalyticsConsentService
  const check = jest.spyOn(consent, 'dispatch').mockResolvedValue(false)
  const analytics = new AnalyticsService({ get: (key: string) => config[key] } as TypedConfigService, consent)
  const provider = new OpenFeaturePostHogProvider({
    apiKey: 'phc_test',
    clientOptions: { host },
    reportExposure: (flag, value, user, org) =>
      analytics.capture(
        { event: '$feature_flag_called', distinctId: user, properties: { flag, value } },
        { users: [user], organizations: org ? [org] : [] },
      ),
  })
  try {
    const context = { targetingKey: 'actor', organizationId: 'organization' }
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    for (enabled of [true, false]) {
      const result = await provider.resolveBooleanEvaluation('rollout', !enabled, context, logger)
      expect(result.value).toBe(enabled)
    }
    await provider.onClose()
    await analytics.onApplicationShutdown()
    expect(check).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(2)
    for (const { path, body } of requests) {
      expect(['/flags/', '/decide/']).toContain(path)
      expect(body).toMatchObject({ distinct_id: 'actor', groups: { organization: 'organization' } })
    }
  } finally {
    await provider.onClose()
    await analytics.onApplicationShutdown()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
