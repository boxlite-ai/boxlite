import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { JobStatus } from '../../box/enums/job-status.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { RegionType } from '../../region/enums/region-type.enum'
import { AdminPlatformOverviewService } from './platform-overview.service'

const repository = () => ({ find: jest.fn(), findOne: jest.fn() })
const serviceWith = () => {
  const regions = repository()
  const runners = repository()
  const boxes = repository()
  const jobs = repository()
  const service = new AdminPlatformOverviewService(regions as never, runners as never, boxes as never, jobs as never)
  return { service, regions, runners, boxes, jobs }
}

describe('AdminPlatformOverviewService', () => {
  it('derives region health from runner and box failures', async () => {
    const { service, regions, runners, boxes, jobs } = serviceWith()
    regions.find.mockResolvedValue([
      {
        id: 'sgp-a',
        name: 'Singapore',
        regionType: RegionType.SHARED,
        updatedAt: new Date('2026-08-30T01:00:00Z'),
      },
    ])
    runners.find.mockResolvedValue([
      {
        id: 'runner-1',
        region: 'sgp-a',
        state: RunnerState.UNRESPONSIVE,
        draining: false,
        cpu: 4,
        memoryGiB: 8,
        updatedAt: new Date('2026-08-30T01:00:01Z'),
      },
    ])
    boxes.find.mockResolvedValue([])
    jobs.find.mockResolvedValue([])

    await expect(service.regions({ limit: 50 })).resolves.toMatchObject({
      items: [{ id: 'sgp-a', state: 'critical' }],
    })
  })

  it('uses runner and box updates for region detail freshness', async () => {
    const { service, regions, runners, boxes, jobs } = serviceWith()
    regions.findOne.mockResolvedValue({
      id: 'sgp-a',
      name: 'Singapore',
      regionType: RegionType.SHARED,
      updatedAt: new Date('2026-08-30T01:00:00Z'),
    })
    runners.find.mockResolvedValue([
      {
        id: 'runner-1',
        region: 'sgp-a',
        state: RunnerState.READY,
        draining: false,
        cpu: 4,
        memoryGiB: 8,
        updatedAt: new Date('2026-08-30T01:00:03Z'),
      },
    ])
    boxes.find.mockResolvedValue([
      {
        id: 'box-1',
        region: 'sgp-a',
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        updatedAt: new Date('2026-08-30T01:00:02Z'),
      },
    ])
    jobs.find.mockResolvedValue([])

    await expect(service.region('sgp-a')).resolves.toMatchObject({ observedAt: '2026-08-30T01:00:03.000Z' })
  })

  it('excludes decommissioned capacity and treats draining runners as degraded', async () => {
    const { service, regions, runners, boxes, jobs } = serviceWith()
    regions.findOne.mockResolvedValue({
      id: 'sgp-a',
      name: 'Singapore',
      regionType: RegionType.SHARED,
      updatedAt: new Date('2026-08-30T01:00:00Z'),
    })
    runners.find.mockResolvedValue([
      {
        id: 'runner-active',
        region: 'sgp-a',
        state: RunnerState.READY,
        draining: true,
        cpu: 4,
        memoryGiB: 8,
        updatedAt: new Date('2026-08-30T01:00:01Z'),
      },
      {
        id: 'runner-retired',
        region: 'sgp-a',
        state: RunnerState.DECOMMISSIONED,
        draining: false,
        cpu: 128,
        memoryGiB: 512,
        updatedAt: new Date('2026-08-30T01:00:02Z'),
      },
    ])
    boxes.find.mockResolvedValue([])
    jobs.find.mockResolvedValue([])

    await expect(service.region('sgp-a')).resolves.toMatchObject({
      state: 'degraded',
      runnerCount: 1,
      cpuCapacityMillis: 4000,
      memoryCapacityBytes: '8589934592',
    })
  })

  it('classifies job failures without returning payloads or raw errors', async () => {
    const { service, jobs } = serviceWith()
    jobs.find.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: 'create_box',
        status: JobStatus.FAILED,
        runnerId: '00000000-0000-4000-8000-000000000001',
        resourceType: ResourceType.BOX,
        resourceId: 'box-1',
        createdAt: new Date('2026-08-30T01:00:00Z'),
        startedAt: new Date('2026-08-30T01:00:01Z'),
        completedAt: new Date('2026-08-30T01:00:03Z'),
        errorMessage: 'network token secret must not escape',
        updatedAt: new Date('2026-08-30T01:00:03Z'),
      },
    ])

    const page = await service.jobs({ limit: 50 })
    expect(page.items[0]).toMatchObject({ errorCategory: 'network', durationMs: 2000 })
    expect(JSON.stringify(page)).not.toMatch(/token secret|payload|errorMessage|resultMetadata|traceContext/)
    expect(jobs.find.mock.calls[0][0].select).not.toMatchObject({
      payload: true,
      resultMetadata: true,
      traceContext: true,
    })
  })

  it('reports versions only for runners still in the active fleet', async () => {
    const { service, runners } = serviceWith()
    runners.find.mockResolvedValue([{ appVersion: 'v1.2.3' }, { appVersion: 'v1.2.3' }, { appVersion: 'v1.2.4' }])

    await expect(service.componentIdentities()).resolves.toMatchObject({
      runners: [
        { version: 'v1.2.3', count: 2 },
        { version: 'v1.2.4', count: 1 },
      ],
    })
    expect(runners.find.mock.calls[0][0].where.state).toMatchObject({
      _type: 'not',
      _value: RunnerState.DECOMMISSIONED,
    })
  })
})
