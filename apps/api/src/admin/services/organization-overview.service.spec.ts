import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxUsagePeriodArchive } from '../../usage/entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../../usage/entities/box-usage-period.entity'
import { AdminOrganizationOverviewService } from './organization-overview.service'

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
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(() => builder),
    builder,
    // Default snapshot: runs the callback with a manager that reports no usage rows.
    manager: {
      transaction: jest.fn(async (_level: unknown, run: (snapshot: unknown) => unknown) =>
        run({ find: jest.fn().mockResolvedValue([]) }),
      ),
    },
  }
}
// A `find` without `take` streams however many rows the table happens to hold, so the
// page bound on the response says nothing about the work behind it.
const unboundedFinds = (find: jest.Mock) =>
  find.mock.calls.filter(([options]) => options && typeof options === 'object' && !('take' in options))
const serviceWith = () => {
  const organizations = repository()
  const memberships = repository()
  const users = repository()
  const boxes = repository()
  const usagePeriods = repository()
  const service = new AdminOrganizationOverviewService(
    organizations as never,
    memberships as never,
    users as never,
    boxes as never,
    usagePeriods as never,
  )
  return { service, organizations, memberships, users, boxes, usagePeriods }
}

describe('AdminOrganizationOverviewService', () => {
  afterEach(() => jest.useRealTimers())

  it('returns the organization projection and treats wildcard characters literally', async () => {
    const { service, organizations, memberships, boxes } = serviceWith()
    organizations.find.mockResolvedValue([{ id: 'org-1', name: 'Acme', updatedAt: new Date('2026-08-30T01:00:00Z') }])
    memberships.builder.getRawMany.mockResolvedValue([{ organizationId: 'org-1', memberCount: '2' }])
    boxes.builder.getRawMany.mockResolvedValue([
      {
        organizationId: 'org-1',
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        boxCount: '1',
        observedAt: new Date('2026-08-30T01:00:00Z'),
      },
    ])

    await expect(service.list({ query: 'Acme_%', limit: 50 })).resolves.toEqual({
      items: [
        {
          organizationId: 'org-1',
          name: 'Acme',
          memberCount: 2,
          boxCount: 1,
          impactState: 'not_impacted',
          observedAt: '2026-08-30T01:00:00.000Z',
        },
      ],
      nextCursor: null,
      limit: 50,
      observedAt: '2026-08-30T01:00:00.000Z',
    })
    expect(organizations.find.mock.calls[0][0].where[0].name).toMatchObject({
      _type: 'ilike',
      _value: '%Acme\\_\\%%',
    })
    expect(boxes.find).not.toHaveBeenCalled()
  })

  it('composes bounded member and box partitions without sensitive fields', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:00:00Z'))
    const { service, organizations, memberships, users, boxes, usagePeriods } = serviceWith()
    const observedAt = new Date('2026-08-30T01:00:00Z')
    organizations.findOne.mockResolvedValue({ id: 'org-1', name: 'Acme', updatedAt: observedAt })
    memberships.find.mockResolvedValue([{ userId: 'usr-1', role: 'owner', createdAt: observedAt }])
    users.find.mockResolvedValue([{ id: 'usr-1', email: 'ops@example.com', name: 'Ops' }])
    boxes.find.mockResolvedValue([
      {
        id: 'box-1',
        organizationId: 'org-1',
        name: 'api',
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        runnerId: null,
        region: 'sgp-a',
        updatedAt: observedAt,
      },
    ])
    const snapshot = {
      find: jest.fn(async (entity: unknown) =>
        entity === BoxUsagePeriod
          ? [{ startAt: new Date('2026-08-30T00:00:00Z'), endAt: new Date('2026-08-30T01:00:00Z'), cpu: 1, disk: 2 }]
          : [{ startAt: new Date('2026-08-29T00:00:00Z'), endAt: new Date('2026-08-29T00:30:00Z'), cpu: 2, disk: 1 }],
      ),
    }
    usagePeriods.manager.transaction.mockImplementation(async (_level: unknown, run: (m: unknown) => unknown) =>
      run(snapshot),
    )

    const dossier = await service.detail('org-1', { memberLimit: 50, boxLimit: 50 })
    expect(dossier).toMatchObject({
      organizationId: 'org-1',
      name: 'Acme',
      members: { items: [{ userId: 'usr-1', email: 'ops@example.com', organizationRole: 'owner' }] },
      boxes: { items: [{ id: 'box-1', name: 'api', observedState: 'started', desiredState: 'started' }] },
      impact: { state: 'not_impacted' },
      usage: { computeSeconds: '7200', storageByteSeconds: '9663676416000' },
    })
    expect(snapshot.find.mock.calls.map(([entity]) => entity)).toEqual([BoxUsagePeriod, BoxUsagePeriodArchive])
    expect(JSON.stringify(dossier)).not.toMatch(/authToken|environment|errorReason|keyPair|publicKeys/)
  })

  it('reports global impact when the impacted box is outside the requested page', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:00:00Z'))
    const { service, organizations, memberships, boxes, usagePeriods } = serviceWith()
    const observedAt = new Date('2026-08-30T01:00:00Z')
    organizations.findOne.mockResolvedValue({ id: 'org-1', name: 'Acme', updatedAt: observedAt })
    memberships.find.mockResolvedValue([])
    boxes.find.mockResolvedValue([
      {
        id: 'box-1',
        organizationId: 'org-1',
        name: 'healthy',
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        runnerId: null,
        region: 'sgp-a',
        updatedAt: observedAt,
      },
      {
        id: 'box-2',
        organizationId: 'org-1',
        name: 'broken',
        state: BoxState.ERROR,
        desiredState: BoxDesiredState.STARTED,
        runnerId: null,
        region: 'sgp-a',
        updatedAt: observedAt,
      },
    ])

    boxes.builder.getMany.mockResolvedValue([
      {
        id: 'box-2',
        organizationId: 'org-1',
        name: 'broken',
        state: BoxState.ERROR,
        desiredState: BoxDesiredState.STARTED,
        runnerId: null,
        region: 'sgp-a',
        updatedAt: observedAt,
      },
    ])

    const dossier = await service.detail('org-1', { memberLimit: 1, boxLimit: 1 })

    expect(dossier).toMatchObject({
      boxes: { items: [{ id: 'box-1' }], nextCursor: expect.any(String) },
      impact: {
        state: 'impacted',
        evidence: [{ boxId: 'box-2', summary: 'broken: error (desired started)' }],
      },
    })
  })

  it('rejects an invalid organization cursor before querying the repository', async () => {
    const { service, organizations } = serviceWith()

    await expect(
      service.list({ cursor: Buffer.from('not-a-uuid').toString('base64url'), limit: 50 }),
    ).rejects.toMatchObject({ status: 400 })
    expect(organizations.find).not.toHaveBeenCalled()
  })

  it('aggregates member and box counts in the database instead of loading their rows', async () => {
    const { service, organizations, memberships, boxes } = serviceWith()
    organizations.find.mockResolvedValue([{ id: 'org-1', name: 'Acme', updatedAt: new Date('2026-08-30T01:00:00Z') }])

    await service.list({ limit: 200 })

    expect(memberships.createQueryBuilder).toHaveBeenCalled()
    expect(boxes.createQueryBuilder).toHaveBeenCalled()
    expect(unboundedFinds(memberships.find)).toEqual([])
    expect(unboundedFinds(boxes.find)).toEqual([])
  })

  it('bounds the organization detail box query to the requested page', async () => {
    const { service, organizations, memberships, boxes } = serviceWith()
    organizations.findOne.mockResolvedValue({ id: 'org-1', name: 'Acme', updatedAt: new Date('2026-08-30T01:00:00Z') })
    memberships.find.mockResolvedValue([])
    boxes.find.mockResolvedValue([])
    await service.detail('org-1', { memberLimit: 25, boxLimit: 25 })

    expect(unboundedFinds(boxes.find)).toEqual([])
  })

  // An unprojected getMany() reads every Box column. `secrets` holds the real secret
  // values (box.dto.ts) and `authToken` is the box's own credential, and the evidence
  // below renders neither — so neither belongs in the API process.
  it('reads only the box columns the impact evidence renders', async () => {
    const { service, organizations, memberships, boxes } = serviceWith()
    organizations.findOne.mockResolvedValue({ id: 'org-1', name: 'Acme', updatedAt: new Date('2026-08-30T01:00:00Z') })
    memberships.find.mockResolvedValue([])
    boxes.find.mockResolvedValue([])

    await service.detail('org-1', { memberLimit: 25, boxLimit: 25 })

    const [columns] = boxes.builder.select.mock.calls[0] ?? []
    expect(columns).toEqual(['box.id', 'box.name', 'box.state', 'box.desiredState', 'box.updatedAt'])
  })

  // list() decodes its cursor before it queries, so a malformed cursor is a 400 there.
  // Decoding after the lookup turns the same input into a 404 on an organization that
  // does not exist, and spends a round trip on one that does.
  it('rejects a malformed member cursor before reading the organization', async () => {
    const { service, organizations } = serviceWith()
    organizations.findOne.mockResolvedValue(null)

    await expect(
      // 'a' decodes to an empty string, so it is not a cursor this API ever handed out.
      service.detail('org-1', { memberCursor: 'a', memberLimit: 25, boxLimit: 25 }),
    ).rejects.toMatchObject({ status: 400 })
    expect(organizations.findOne).not.toHaveBeenCalled()
  })

  // Rollover deletes the live row and inserts a fresh-id archive copy in one transaction
  // (usage.service.ts). Two reads on two pool connections straddle that commit: the period
  // is counted twice or lost, and the archive id is new so it cannot be de-duplicated.
  it('reads live and archived usage from one snapshot', async () => {
    const { service, organizations, memberships, boxes, usagePeriods } = serviceWith()
    organizations.findOne.mockResolvedValue({ id: 'org-1', name: 'Acme', updatedAt: new Date('2026-08-30T01:00:00Z') })
    memberships.find.mockResolvedValue([])
    boxes.find.mockResolvedValue([])
    const manager = { find: jest.fn().mockResolvedValue([]) }
    usagePeriods.manager.transaction.mockImplementation(async (_level: unknown, run: (m: unknown) => unknown) =>
      run(manager),
    )

    await service.detail('org-1', { memberLimit: 25, boxLimit: 25 })

    expect(usagePeriods.manager.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function))
    expect(usagePeriods.find).not.toHaveBeenCalled()
    expect(manager.find).toHaveBeenCalledTimes(2)
  })
})
