import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { JobStatus } from '../../box/enums/job-status.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { RegionType } from '../../region/enums/region-type.enum'
import { AdminPlatformOverviewService } from './platform-overview.service'

const queryBuilder = () => {
  const builder: Record<string, jest.Mock> = {}
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'innerJoin',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
    'setParameters',
    'take',
  ]) {
    builder[method] = jest.fn(() => builder)
  }
  builder.getRawMany = jest.fn().mockResolvedValue([])
  builder.getMany = jest.fn().mockResolvedValue([])
  return builder
}
const repository = () => {
  const builder = queryBuilder()
  return { find: jest.fn(), findOne: jest.fn(), createQueryBuilder: jest.fn(() => builder), builder }
}
// A `find` without `take` streams however many rows the table happens to hold, so the
// page bound on the response says nothing about the work behind it.
const unboundedFinds = (find: jest.Mock) =>
  find.mock.calls.filter(([options]) => options && typeof options === 'object' && !('take' in options))
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
    runners.builder.getRawMany.mockResolvedValue([
      {
        region: 'sgp-a',
        state: RunnerState.UNRESPONSIVE,
        draining: false,
        runnerCount: '1',
        cpuTotal: 4,
        memoryTotal: 8,
        observedAt: new Date('2026-08-30T01:00:01Z'),
      },
    ])

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
    runners.builder.getRawMany.mockResolvedValue([
      {
        region: 'sgp-a',
        state: RunnerState.READY,
        draining: false,
        runnerCount: '1',
        cpuTotal: 4,
        memoryTotal: 8,
        observedAt: new Date('2026-08-30T01:00:03Z'),
      },
    ])
    boxes.builder.getRawMany.mockResolvedValue([
      {
        region: 'sgp-a',
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        boxCount: '1',
        observedAt: new Date('2026-08-30T01:00:02Z'),
      },
    ])

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
    runners.builder.getRawMany.mockResolvedValue([
      {
        region: 'sgp-a',
        state: RunnerState.READY,
        draining: true,
        runnerCount: '1',
        cpuTotal: 4,
        memoryTotal: 8,
        observedAt: new Date('2026-08-30T01:00:01Z'),
      },
      {
        region: 'sgp-a',
        state: RunnerState.DECOMMISSIONED,
        draining: false,
        runnerCount: '1',
        cpuTotal: 128,
        memoryTotal: 512,
        observedAt: new Date('2026-08-30T01:00:02Z'),
      },
    ])

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
    // The whole projection, not three named columns: one `not.toMatchObject` over three
    // keys only fails when the read carries all three, so it stays green while any single
    // one of them comes back. A job row also holds `payload`, `resultMetadata`, and
    // `traceContext`, and the summary above renders none of them.
    expect(jobs.find.mock.calls[0][0].select).toEqual({
      id: true,
      type: true,
      status: true,
      runnerId: true,
      resourceType: true,
      resourceId: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      errorMessage: true,
      updatedAt: true,
    })
  })

  it('reports versions only for runners still in the active fleet', async () => {
    const { service, runners } = serviceWith()
    runners.builder.getRawMany.mockResolvedValue([
      { version: 'v1.2.3', runnerCount: '2' },
      { version: 'v1.2.4', runnerCount: '1' },
    ])

    await expect(service.componentIdentities()).resolves.toMatchObject({
      runners: [
        { version: 'v1.2.3', count: 2 },
        { version: 'v1.2.4', count: 1 },
      ],
    })
    // The bound value, not just the word "state": a clause that merely mentions the column
    // would still pass while the fleet filter drifted to some other runner state.
    expect(runners.builder.where).toHaveBeenCalledWith(expect.stringContaining('runner.state !='), {
      decommissioned: RunnerState.DECOMMISSIONED,
    })
  })

  it('aggregates region capacity in the database instead of loading runner and box rows', async () => {
    const { service, regions, runners, boxes, jobs } = serviceWith()
    regions.find.mockResolvedValue([
      {
        id: 'sgp-a',
        name: 'Singapore',
        regionType: RegionType.SHARED,
        updatedAt: new Date('2026-08-30T01:00:00Z'),
      },
    ])

    await service.regions({ limit: 200 })

    expect(runners.createQueryBuilder).toHaveBeenCalled()
    expect(boxes.createQueryBuilder).toHaveBeenCalled()
    expect(unboundedFinds(runners.find)).toEqual([])
    expect(unboundedFinds(boxes.find)).toEqual([])
    expect(unboundedFinds(jobs.find)).toEqual([])
  })

  it('aggregates a single region without loading every row it holds', async () => {
    const { service, regions, runners, boxes, jobs } = serviceWith()
    regions.findOne.mockResolvedValue({
      id: 'sgp-a',
      name: 'Singapore',
      regionType: RegionType.SHARED,
      updatedAt: new Date('2026-08-30T01:00:00Z'),
    })

    await service.region('sgp-a')

    expect(unboundedFinds(runners.find)).toEqual([])
    expect(unboundedFinds(boxes.find)).toEqual([])
    expect(unboundedFinds(jobs.find)).toEqual([])
  })

  // status-sync.service.ts scopes the serving fleet to READY|UNRESPONSIVE because
  // "INITIALIZING is the birth state (fleet expansion must not page) and
  // DISABLED/... are operator intent". Neither is a failure to report as one.
  it.each([RunnerState.INITIALIZING, RunnerState.DISABLED])(
    'does not degrade a region because a runner is %s',
    async (state) => {
      const { service, regions, runners, boxes } = serviceWith()
      regions.findOne.mockResolvedValue({
        id: 'sgp-a',
        name: 'Singapore',
        regionType: RegionType.SHARED,
        updatedAt: new Date('2026-08-30T01:00:00Z'),
      })
      runners.builder.getRawMany.mockResolvedValue([
        {
          region: 'sgp-a',
          state: RunnerState.READY,
          draining: false,
          runnerCount: '1',
          cpuTotal: 4,
          memoryTotal: 8,
          observedAt: null,
        },
        { region: 'sgp-a', state, draining: false, runnerCount: '1', cpuTotal: 4, memoryTotal: 8, observedAt: null },
      ])
      boxes.builder.getRawMany.mockResolvedValue([])

      await expect(service.region('sgp-a')).resolves.toMatchObject({ state: 'healthy' })
    },
  )

  // Not degrading on INITIALIZING/DISABLED must not become "healthy with no serving
  // capacity": once UNRESPONSIVE has already produced critical, READY runners are the only
  // ones left that carry traffic, so the empty-capacity branch has to count those, not
  // every runner that merely is not decommissioned.
  it.each([
    [1, 'degraded'],
    [0, 'unknown'],
  ])('reports a region with no ready runners and %i boxes as %s', async (boxCount, expected) => {
    const { service, regions, runners, boxes } = serviceWith()
    regions.findOne.mockResolvedValue({
      id: 'sgp-a',
      name: 'Singapore',
      regionType: RegionType.SHARED,
      updatedAt: new Date('2026-08-30T01:00:00Z'),
    })
    runners.builder.getRawMany.mockResolvedValue([
      {
        region: 'sgp-a',
        state: RunnerState.INITIALIZING,
        draining: false,
        runnerCount: '2',
        cpuTotal: 8,
        memoryTotal: 16,
        observedAt: null,
      },
    ])
    boxes.builder.getRawMany.mockResolvedValue(
      boxCount
        ? [
            {
              region: 'sgp-a',
              state: BoxState.STARTED,
              desiredState: BoxDesiredState.STARTED,
              boxCount: String(boxCount),
              observedAt: null,
            },
          ]
        : [],
    )

    await expect(service.region('sgp-a')).resolves.toMatchObject({ state: expected, runnerCount: 2 })
  })

  it('paginates box jobs instead of silently truncating the list', async () => {
    const { service, boxes, jobs } = serviceWith()
    boxes.findOne.mockResolvedValue({
      id: 'box-1',
      name: 'box',
      organizationId: 'org-1',
      runnerId: null,
      region: 'sgp-a',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTED,
      cpu: 2,
      mem: 4,
      disk: 10,
      updatedAt: new Date('2026-08-30T01:00:00Z'),
    })
    jobs.builder.getMany.mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000001', type: 'create_box', createdAt: new Date('2026-08-30T03:00:00Z') },
      { id: '00000000-0000-4000-8000-000000000002', type: 'start_box', createdAt: new Date('2026-08-30T02:00:00Z') },
      { id: '00000000-0000-4000-8000-000000000003', type: 'stop_box', createdAt: new Date('2026-08-30T01:00:00Z') },
    ])

    const detail = await service.box('box-1', { jobLimit: 2 })

    expect(detail?.jobs.items).toHaveLength(2)
    expect(detail?.jobs.nextCursor).not.toBeNull()
  })

  // The integration spec proves the ordering against real rows, but it only runs where a
  // Postgres is reachable. This pins the clause itself so a silent return to ordering by a
  // random v4 id fails in an ordinary run too.
  it('asks the database for the newest jobs first and seeks past the cursor pair', async () => {
    const { service, boxes, jobs } = serviceWith()
    boxes.findOne.mockResolvedValue({
      id: 'box-1',
      name: 'box',
      organizationId: 'org-1',
      runnerId: null,
      region: 'sgp-a',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTED,
      cpu: 2,
      mem: 4,
      disk: 10,
      updatedAt: new Date('2026-08-30T01:00:00Z'),
    })
    jobs.builder.getMany.mockResolvedValue([])

    await service.box('box-1', {
      jobLimit: 2,
      jobCursor: Buffer.from('2026-08-30T02:00:00.000Z|00000000-0000-4000-8000-000000000002').toString('base64url'),
    })

    // The sort key is the truncated column, not the stored one: the cursor is built from a
    // JS Date and cannot name a microsecond, so seeking it into an untruncated createdAt
    // steps over every row sharing the boundary row's millisecond.
    const sortKey = `date_trunc('milliseconds', job."createdAt")`
    expect(jobs.builder.orderBy).toHaveBeenCalledWith(sortKey, 'DESC')
    expect(jobs.builder.addOrderBy).toHaveBeenCalledWith(expect.stringContaining('job.id'), 'DESC')
    expect(jobs.builder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(`(${sortKey}, job.id) < (:jobCreatedAt, :jobId)`),
      { jobCreatedAt: '2026-08-30T02:00:00.000Z', jobId: '00000000-0000-4000-8000-000000000002' },
    )
  })

  // Every other cursor entry point decodes before it queries, so a malformed cursor is a
  // 400 there. Decoding after the lookup turns the same input into a 404 on a box that
  // does not exist, and spends a round trip on one that does.
  it('rejects a malformed job cursor before reading the box', async () => {
    const { service, boxes } = serviceWith()
    boxes.findOne.mockResolvedValue(null)

    await expect(
      service.box('box-1', { jobCursor: Buffer.from('not-a-uuid').toString('base64url'), jobLimit: 50 }),
    ).rejects.toMatchObject({ status: 400 })
    expect(boxes.findOne).not.toHaveBeenCalled()
  })

  // The controller advertises 400 for an invalid cursor, so the timestamp half has to be
  // held to what minted it. Date.parse alone reads '2026' as a year and lets it through to
  // a parameter Postgres rejects outright ('invalid input syntax for type timestamp with
  // time zone'), which reaches the operator as a 500.
  it('rejects a cursor timestamp the database would not accept', async () => {
    const { service, boxes } = serviceWith()

    await expect(
      service.box('box-1', {
        jobCursor: Buffer.from('2026|00000000-0000-4000-8000-000000000002').toString('base64url'),
        jobLimit: 50,
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(boxes.findOne).not.toHaveBeenCalled()
  })

  // BoxDesiredState has no UNKNOWN member, so an unknown box can never equal its desired
  // state. Comparing the two first would report it as degraded and leave the 'unknown'
  // the DTO advertises unreachable.
  it('reports an unknown box as unknown rather than degraded', async () => {
    const { service, boxes, jobs } = serviceWith()
    boxes.find.mockResolvedValue([
      {
        id: 'box-1',
        name: 'box',
        organizationId: 'org-1',
        runnerId: null,
        region: 'sgp-a',
        desiredState: BoxDesiredState.STARTED,
        state: BoxState.UNKNOWN,
        cpu: 2,
        mem: 4,
        disk: 10,
        updatedAt: new Date('2026-08-30T01:00:00Z'),
      },
    ])
    jobs.builder.getRawMany.mockResolvedValue([])

    const page = await service.boxes({ limit: 50 })

    expect(page.items[0]).toMatchObject({ observedState: BoxState.UNKNOWN, health: 'unknown' })
  })

  it('reports the api version the deployment injects', async () => {
    const { service } = serviceWith()
    const previous = process.env.VERSION
    process.env.VERSION = '0.42.1'
    try {
      await expect(service.componentIdentities()).resolves.toMatchObject({ api: { version: '0.42.1' } })
    } finally {
      if (previous === undefined) delete process.env.VERSION
      else process.env.VERSION = previous
    }
  })
})
