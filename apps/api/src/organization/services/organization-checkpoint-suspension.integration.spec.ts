/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxLastActivity } from '../../box/entities/box-last-activity.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { OrganizationService } from './organization.service'
import { OrganizationEvents } from '../constants/organization-events.constant'

const databaseTests = process.env.DB_HOST ? describe : describe.skip
const schema = `checkpoint_suspension_${randomUUID().replaceAll('-', '')}`

databaseTests('Memory checkpoint suspended organization', () => {
  let source: DataSource
  beforeAll(async () => {
    source = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Box, BoxLastActivity],
      entitySkipConstructor: true,
      namingStrategy: new CustomNamingStrategy(),
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await source.query(`CREATE SCHEMA "${schema}"`)
    await source.synchronize()
    await source.query(
      `CREATE TABLE "${schema}".organization (id uuid PRIMARY KEY, suspended boolean, "suspendedAt" timestamptz, "suspensionCleanupGracePeriodHours" integer)`,
    )
  })
  afterAll(async () => {
    if (source?.isInitialized) {
      await source.query(`DROP SCHEMA "${schema}" CASCADE`)
      await source.destroy()
    }
  })
  it('emits the normal stop action for a Paused VM after the suspension grace period', async () => {
    const organizationId = randomUUID(),
      activeOrganization = randomUUID()
    await source.query(
      `INSERT INTO "${schema}".organization VALUES ($1,true,now()-interval '2 hours',1), ($2,false,now()-interval '2 hours',1)`,
      [organizationId, activeOrganization],
    )
    const paused = new Box('test', 'paused'),
      active = new Box('test', 'active')
    for (const [box, owner] of [
      [paused, organizationId],
      [active, activeOrganization],
    ] as const) {
      Object.assign(box, {
        organizationId: owner,
        osUser: 'boxlite',
        labels: {},
        state: 'paused' as BoxState,
        desiredState: 'paused' as BoxDesiredState,
        pending: false,
      })
      await source.getRepository(Box).insert(box)
    }
    const emitAsync = jest.fn().mockResolvedValue(undefined)
    const service = Object.assign(Object.create(OrganizationService.prototype), {
      activeJobs: new Set(),
      organizationRepository: {
        createQueryBuilder: (alias) => source.createQueryBuilder().from(`${schema}.organization`, alias),
      },
      boxRepository: source.getRepository(Box),
      redisLockProvider: { lock: async () => true, unlock: async () => {} },
      eventEmitter: { emitAsync },
    })
    await service.stopSuspendedOrganizationBoxes()
    expect(emitAsync).toHaveBeenCalledTimes(1)
    expect(emitAsync).toHaveBeenCalledWith(
      OrganizationEvents.SUSPENDED_BOX_STOPPED,
      expect.objectContaining({ boxId: paused.id }),
    )
  })
})
