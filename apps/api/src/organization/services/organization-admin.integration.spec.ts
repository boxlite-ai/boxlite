/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { AddInvitationRequests1792728001000 } from '../../migrations/pre-deploy/1792728001000-add-invitation-requests-migration'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Organization } from '../entities/organization.entity'
import { OrganizationInvitation } from '../entities/organization-invitation.entity'
import { OrganizationRole } from '../entities/organization-role.entity'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationInvitationStatus } from '../enums/organization-invitation-status.enum'
import { OrganizationInvitationService } from './organization-invitation.service'
import { OrganizationUserService } from './organization-user.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `org_admin_${randomUUID().replaceAll('-', '')}`
describeIfDatabase('Admin organization storage (real Postgres)', () => {
  let db: DataSource
  let organizations: Repository<Organization>
  let invitations: Repository<OrganizationInvitation>
  let memberships: Repository<OrganizationUser>
  let invites: OrganizationInvitationService
  let users: OrganizationUserService
  let organizationId: string
  const eventEmitter = { emit: jest.fn() }
  const orgService = { findOne: jest.fn() }
  const payload = { email: 'new@example.com', role: OrganizationMemberRole.OWNER, assignedRoleIds: [] }
  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    const runner = db.createQueryRunner()
    try {
      await new AddInvitationRequests1792728001000().up(runner)
    } finally {
      await runner.release()
    }
    organizations = db.getRepository(Organization)
    invitations = db.getRepository(OrganizationInvitation)
    memberships = db.getRepository(OrganizationUser)
    invites = new OrganizationInvitationService(
      invitations,
      orgService as any,
      { findOne: async () => null } as any,
      { findByIds: async () => [] } as any,
      { findOneByEmail: async () => null } as any,
      eventEmitter as any,
      db,
      { getOrThrow: () => 604800 } as any,
    )
    users = new OrganizationUserService(
      memberships,
      {} as any,
      { findByIds: async () => [] } as any,
      eventEmitter as any,
      db,
      {} as any,
    )
  })
  afterAll(async () => {
    if (!db?.isInitialized) return
    try {
      const runner = db.createQueryRunner()
      try {
        await new AddInvitationRequests1792728001000().down(runner)
      } finally {
        await runner.release()
      }
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await db.destroy()
    }
  })
  beforeEach(async () => {
    jest.restoreAllMocks()
    eventEmitter.emit.mockClear()
    await organizations.query(`DELETE FROM "${schema}".organization`)
    const org = await organizations.save({ name: 'Admin test', createdBy: 'owner' })
    organizationId = org.id
    orgService.findOne.mockImplementation((id: string) => organizations.findOneBy({ id }))
  })
  function create(key: string, dto = payload, userId = 'owner', org = organizationId) {
    return invites.create(org, dto, 'owner@example.com', { userId, idempotencyKey: key })
  }
  it('replays the original snapshot after cancellation without sending another notification', async () => {
    const key = randomUUID()
    const first = await create(key)
    await invites.cancel(organizationId, first.id)
    const replay = await create(key)
    expect(replay.id).toBe(first.id)
    expect(replay.status).toBe(OrganizationInvitationStatus.PENDING)
    expect(new Date(replay.createdAt)).toEqual(first.createdAt)
    expect(await invitations.count()).toBe(1)
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1)
  })
  it('rejects a changed request under the same idempotency key with 422', async () => {
    const key = randomUUID()
    await create(key)
    await expect(create(key, { ...payload, email: 'different@example.com' })).rejects.toMatchObject({ status: 422 })
    expect(await invitations.count()).toBe(1)
  })
  it('isolates replay records by user and organization', async () => {
    const key = randomUUID()
    const first = await create(key)
    const second = await create(key, { ...payload, email: 'second@example.com' }, 'other-owner')
    const org = await organizations.save({ name: 'Other', createdBy: 'owner' })
    const third = await create(key, payload, 'owner', org.id)
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    // A retry must still find the result in each independent partition.
    expect((await create(key)).id).toBe(first.id)
    expect((await create(key, { ...payload, email: 'second@example.com' }, 'other-owner')).id).toBe(second.id)
    expect((await create(key, payload, 'owner', org.id)).id).toBe(third.id)
  })
  it('rejects a concurrent request while the first transaction owns the key', async () => {
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    orgService.findOne.mockImplementationOnce(async (id: string) => {
      started()
      await held
      return organizations.findOneBy({ id })
    })
    const key = randomUUID()
    const first = create(key)
    try {
      await entered
      await expect(create(key)).rejects.toMatchObject({ status: 409 })
    } finally {
      release()
      await first
    }
    expect(await invitations.count()).toBe(1)
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1)
  })
  it('does not retain a failed request and allows the same key to be retried', async () => {
    const key = randomUUID()
    orgService.findOne.mockRejectedValueOnce(new Error('lookup failed'))
    await expect(create(key)).rejects.toThrow('lookup failed')
    const first = await create(key)
    expect((await create(key)).id).toBe(first.id)
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1)
  })
  it('starts a new operation once the replay window has expired', async () => {
    const key = randomUUID()
    const first = await create(key)
    await invites.cancel(organizationId, first.id)
    await db.query('UPDATE organization_invitation_request SET "expiresAt" = now() - interval \'1 second\'')
    const next = await create(key)
    expect(next.id).not.toBe(first.id)
    expect((await create(key)).id).toBe(next.id)
    expect(eventEmitter.emit).toHaveBeenCalledTimes(2)
  })

  it('replays a successful request after its explicit invitation deadline', async () => {
    const now = Date.now()
    const dto = { ...payload, expiresAt: new Date(now + 3600000) }
    const key = randomUUID()
    const first = await create(key, dto)
    jest.useFakeTimers({
      now: now + 7200000,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    })
    try {
      const replay = await create(key.toUpperCase(), dto)
      expect(replay.id).toBe(first.id)
      expect(new Date(replay.expiresAt)).toEqual(dto.expiresAt)
      expect(replay.status).toBe('pending')
      expect(await invitations.count()).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })
  it('rolls back the invitation if persisting its replay record fails', async () => {
    await db.query(`ALTER TABLE organization_invitation_request ADD CONSTRAINT reject_replay CHECK (false) NOT VALID`)
    const key = randomUUID()
    try {
      await expect(create(key)).rejects.toMatchObject({ driverError: { code: '23514' } })
      expect(await invitations.count()).toBe(0)
      expect(eventEmitter.emit).not.toHaveBeenCalled()
    } finally {
      await db.query('ALTER TABLE organization_invitation_request DROP CONSTRAINT reject_replay')
    }
    const retry = await create(key)
    expect((await create(key)).id).toBe(retry.id)
  })
  it('rejects a fresh Admin request with an expired deadline, without changing Cloud creation', async () => {
    const dto = { ...payload, expiresAt: new Date('2020-01-01Z') }
    await expect(invites.create(organizationId, dto, 'owner@example.com', { userId: 'owner' })).rejects.toMatchObject({
      status: 400,
    })
    expect(await invitations.count()).toBe(0)
    const cloud = await invites.create(organizationId, dto, 'owner@example.com')
    expect(cloud.expiresAt).toEqual(dto.expiresAt)
  })
  it('pages users at the database boundary without including another organization', async () => {
    const other = await organizations.save({ name: 'Other', createdBy: 'owner' })
    for (const id of ['a', 'b', 'c', 'd']) await memberships.save({ organizationId, userId: id })
    await memberships.save({ organizationId: other.id, userId: 'aa' })
    const page = users.findPage.bind(users)
    expect((await page(organizationId, 2)).map((user: any) => user.userId)).toEqual(['a', 'b', 'c'])
    expect((await page(organizationId, 2, 'b')).map((user: any) => user.userId)).toEqual(['c', 'd'])
  })
  it('pages all invitation states, including expired rows, within the selected organization', async () => {
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ]
    for (const [i, id] of ids.entries())
      await invitations.save({
        id,
        organizationId,
        email: `${i}@example.com`,
        role: OrganizationMemberRole.OWNER,
        expiresAt: new Date(i === 0 ? '2020-01-01Z' : '2099-01-01Z'),
        status: i === 1 ? OrganizationInvitationStatus.ACCEPTED : OrganizationInvitationStatus.PENDING,
      })
    const other = await organizations.save({ name: 'Other', createdBy: 'owner' })
    await invitations.save({ organizationId: other.id, email: 'other@example.com', expiresAt: new Date('2099-01-01Z') })
    const page = invites.findPage.bind(invites)
    expect((await page(organizationId, 2)).map((invite: any) => invite.id)).toEqual(ids.slice(0, 3))
    expect((await page(organizationId, 2, ids[1])).map((invite: any) => invite.id)).toEqual(ids.slice(2))
  })
})
