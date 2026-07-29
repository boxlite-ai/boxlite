/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrgMetricsExporterService } from './org-metrics-exporter.service'

type PushedPayload = {
  resourceMetrics: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }
    scopeMetrics: Array<{
      scope: { name: string; version: string }
      metrics: Array<{ name: string; unit: string; gauge: { dataPoints: Array<{ asInt: string }> } }>
    }>
  }>
}

const USAGE = { cpu: 12, memory: 48, disk: 300, gpu: 2, count: 3 }
const LIMITS = {
  totalCpuQuota: 64,
  totalMemoryQuota: 256,
  totalDiskQuota: 512,
  totalGpuQuota: 8,
  maxConcurrentBoxes: 50,
}

function makeService(
  overrides: {
    collectorUrl?: string
    lockAcquired?: boolean
    organizations?: Array<{ id: string }>
    limits?: typeof LIMITS
    usage?: typeof USAGE
  } = {},
) {
  const { lockAcquired = true, organizations = [{ id: 'org-1' }], limits = LIMITS, usage = USAGE } = overrides
  // Not destructured with a default: `{ collectorUrl: undefined }` must mean
  // "unconfigured", and a destructuring default would silently substitute the URL.
  const collectorUrl = 'collectorUrl' in overrides ? overrides.collectorUrl : 'http://collector:4318'

  const organizationService = { findOrganizationsWithOtelConfig: jest.fn().mockResolvedValue(organizations) }
  const organizationUsageService = {
    getQuotaLimits: jest.fn().mockResolvedValue(limits),
    getBoxUsageOverview: jest.fn().mockResolvedValue(usage),
  }
  const configService = { get: jest.fn().mockReturnValue(collectorUrl) }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(lockAcquired),
    unlock: jest.fn().mockResolvedValue(undefined),
  }

  const service = new OrgMetricsExporterService(
    organizationService as never,
    organizationUsageService as never,
    configService as never,
    redisLockProvider as never,
  )

  return { service, organizationService, organizationUsageService, redisLockProvider }
}

/** Captures what the service POSTs, so assertions read production-built payloads. */
function mockFetch(status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({ ok: status < 400, status, text: async () => '' })
  global.fetch = fetchMock as never
  return fetchMock
}

function pushedPayload(fetchMock: jest.Mock, call = 0): PushedPayload {
  return JSON.parse(fetchMock.mock.calls[call][1].body)
}

function metricValue(payload: PushedPayload, name: string): string | undefined {
  const metric = payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name)
  return metric?.gauge.dataPoints[0]?.asInt
}

describe('OrgMetricsExporterService', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    delete (global as { fetch?: unknown }).fetch
  })

  describe('guards', () => {
    it('does nothing when no collector URL is configured', async () => {
      const fetchMock = mockFetch()
      const { service, redisLockProvider } = makeService({ collectorUrl: undefined })

      await service.exportOrgMetrics()

      expect(redisLockProvider.lock).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does nothing when another instance holds the lock', async () => {
      const fetchMock = mockFetch()
      const { service, organizationService } = makeService({ lockAcquired: false })

      await service.exportOrgMetrics()

      expect(organizationService.findOrganizationsWithOtelConfig).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('releases the lock even when an organization export throws', async () => {
      mockFetch()
      const { service, organizationUsageService, redisLockProvider } = makeService()
      organizationUsageService.getQuotaLimits.mockRejectedValue(new Error('redis down'))

      await service.exportOrgMetrics()

      expect(redisLockProvider.unlock).toHaveBeenCalledWith('org-metrics-export')
    })

    it('releases the lock when there are no opted-in organizations', async () => {
      const fetchMock = mockFetch()
      const { service, redisLockProvider } = makeService({ organizations: [] })

      await service.exportOrgMetrics()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(redisLockProvider.unlock).toHaveBeenCalledWith('org-metrics-export')
    })
  })

  describe('payload', () => {
    it('posts OTLP metrics to /v1/metrics tagged with the organization id', async () => {
      const fetchMock = mockFetch()
      const { service } = makeService()

      await service.exportOrgMetrics()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe('http://collector:4318/v1/metrics')
      expect(fetchMock.mock.calls[0][1].headers['organization-id']).toBe('org-1')

      const payload = pushedPayload(fetchMock)
      expect(payload.resourceMetrics[0].resource.attributes).toEqual([
        { key: 'organization.id', value: { stringValue: 'org-1' } },
      ])
      expect(payload.resourceMetrics[0].scopeMetrics[0].scope.name).toBe('boxlite.api.org_metrics')
    })

    it('reports current usage from the usage overview', async () => {
      const fetchMock = mockFetch()
      const { service } = makeService()

      await service.exportOrgMetrics()
      const payload = pushedPayload(fetchMock)

      expect(metricValue(payload, 'boxlite.box.used_cpu')).toBe('12')
      expect(metricValue(payload, 'boxlite.box.used_ram')).toBe('48')
      expect(metricValue(payload, 'boxlite.box.used_storage')).toBe('300')
    })

    it('reports quota ceilings from the organization quota limits', async () => {
      const fetchMock = mockFetch()
      const { service } = makeService()

      await service.exportOrgMetrics()
      const payload = pushedPayload(fetchMock)

      expect(metricValue(payload, 'boxlite.box.total_cpu')).toBe('64')
      expect(metricValue(payload, 'boxlite.box.total_ram')).toBe('256')
      expect(metricValue(payload, 'boxlite.box.total_storage')).toBe('512')
    })

    // Upstream declares no `total_gpu` metric, so its guarded addDataPoint call is a
    // silent no-op. BoxLite declares it, so a GPU quota actually reaches the collector.
    it('reports the GPU quota when the organization has one', async () => {
      const fetchMock = mockFetch()
      const { service } = makeService()

      await service.exportOrgMetrics()

      expect(metricValue(pushedPayload(fetchMock), 'boxlite.box.total_gpu')).toBe('8')
    })

    it('omits quota metrics that are not positive', async () => {
      const fetchMock = mockFetch()
      const { service } = makeService({ limits: { ...LIMITS, totalGpuQuota: 0, totalDiskQuota: 0 } })

      await service.exportOrgMetrics()
      const payload = pushedPayload(fetchMock)

      expect(metricValue(payload, 'boxlite.box.total_gpu')).toBeUndefined()
      expect(metricValue(payload, 'boxlite.box.total_storage')).toBeUndefined()
      expect(metricValue(payload, 'boxlite.box.total_cpu')).toBe('64')
    })
  })

  describe('batching', () => {
    it('exports every organization, in batches of at most 5', async () => {
      const fetchMock = mockFetch()
      const organizations = Array.from({ length: 12 }, (_, i) => ({ id: `org-${i}` }))
      const { service } = makeService({ organizations })

      await service.exportOrgMetrics()

      expect(fetchMock).toHaveBeenCalledTimes(12)
      const exported = fetchMock.mock.calls.map((call) => call[1].headers['organization-id'])
      expect(exported).toEqual(organizations.map((org) => org.id))
    })

    it('one organization failing does not stop the rest', async () => {
      const fetchMock = mockFetch()
      const { service, organizationUsageService } = makeService({
        organizations: [{ id: 'org-a' }, { id: 'org-b' }],
      })
      organizationUsageService.getBoxUsageOverview.mockImplementation(async (orgId: string) => {
        if (orgId === 'org-a') {
          throw new Error('usage unavailable')
        }
        return USAGE
      })

      await service.exportOrgMetrics()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1].headers['organization-id']).toBe('org-b')
    })

    it('a non-OK collector response is tolerated, not thrown', async () => {
      const fetchMock = mockFetch(503)
      const { service, redisLockProvider } = makeService()

      await expect(service.exportOrgMetrics()).resolves.toBeUndefined()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(redisLockProvider.unlock).toHaveBeenCalledWith('org-metrics-export')
    })
  })
})
