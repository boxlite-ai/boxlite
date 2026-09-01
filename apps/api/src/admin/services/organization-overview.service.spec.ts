import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { AdminOrganizationOverviewService } from './organization-overview.service'

const repository = () => ({ find: jest.fn(), findOne: jest.fn() })
const serviceWith = () => {
  const organizations = repository()
  const memberships = repository()
  const users = repository()
  const boxes = repository()
  const usagePeriods = repository()
  const usageArchives = repository()
  const service = new AdminOrganizationOverviewService(
    organizations as never,
    memberships as never,
    users as never,
    boxes as never,
    usagePeriods as never,
    usageArchives as never,
  )
  return { service, organizations, memberships, users, boxes, usagePeriods, usageArchives }
}

describe('AdminOrganizationOverviewService', () => {
  afterEach(() => jest.useRealTimers())

  it('returns the organization projection and treats wildcard characters literally', async () => {
    const { service, organizations, memberships, boxes } = serviceWith()
    organizations.find.mockResolvedValue([{ id: 'org-1', name: 'Acme', updatedAt: new Date('2026-08-30T01:00:00Z') }])
    memberships.find.mockResolvedValue([
      { organizationId: 'org-1', userId: 'usr-1' },
      { organizationId: 'org-1', userId: 'usr-2' },
    ])
    boxes.find.mockResolvedValue([
      {
        organizationId: 'org-1',
        state: BoxState.STARTED,
        desiredState: BoxDesiredState.STARTED,
        updatedAt: new Date('2026-08-30T01:00:00Z'),
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
    expect(boxes.find.mock.calls[0][0].select).not.toMatchObject({
      authToken: true,
      env: true,
      errorReason: true,
    })
  })

  it('composes bounded member and box partitions without sensitive fields', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:00:00Z'))
    const { service, organizations, memberships, users, boxes, usagePeriods, usageArchives } = serviceWith()
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
    usagePeriods.find.mockResolvedValue([
      {
        startAt: new Date('2026-08-30T00:00:00Z'),
        endAt: new Date('2026-08-30T01:00:00Z'),
        cpu: 1,
        disk: 2,
      },
    ])
    usageArchives.find.mockResolvedValue([
      {
        startAt: new Date('2026-08-29T00:00:00Z'),
        endAt: new Date('2026-08-29T00:30:00Z'),
        cpu: 2,
        disk: 1,
      },
    ])

    const dossier = await service.detail('org-1', { memberLimit: 50, boxLimit: 50 })
    expect(dossier).toMatchObject({
      organizationId: 'org-1',
      name: 'Acme',
      members: { items: [{ userId: 'usr-1', email: 'ops@example.com', organizationRole: 'owner' }] },
      boxes: { items: [{ id: 'box-1', name: 'api', observedState: 'started', desiredState: 'started' }] },
      impact: { state: 'not_impacted' },
      usage: { computeSeconds: '7200', storageByteSeconds: '9663676416000' },
    })
    expect(usagePeriods.find).toHaveBeenCalledTimes(1)
    expect(usageArchives.find).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(dossier)).not.toMatch(/authToken|environment|errorReason|keyPair|publicKeys/)
  })

  it('reports global impact when the impacted box is outside the requested page', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:00:00Z'))
    const { service, organizations, memberships, boxes, usagePeriods, usageArchives } = serviceWith()
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
    usagePeriods.find.mockResolvedValue([])
    usageArchives.find.mockResolvedValue([])

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
})
