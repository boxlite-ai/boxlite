/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { join } from 'path'
import { DataSource } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { Job } from '../../box/entities/job.entity'
import { Runner } from '../../box/entities/runner.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { JobStatus } from '../../box/enums/job-status.enum'
import { JobType } from '../../box/enums/job-type.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { Organization } from '../../organization/entities/organization.entity'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxUsagePeriod } from '../../usage/entities/box-usage-period.entity'
import { User } from '../../user/user.entity'
import { AdminOrganizationOverviewService } from './organization-overview.service'
import { AdminPlatformOverviewService } from './platform-overview.service'

// Both overview services project their counts with hand-written SQL: GROUP BY
// aggregates, a runner-to-job join, and a comparison between two separate
// Postgres enum types. A stubbed query builder hands the assertion whatever the
// test put in it, so none of that SQL is parsed by anything until a real
// database sees it — `runner.id` is uuid while `job."runnerId"` is character
// varying, and Postgres has no implicit cast between them. Runs only when a
// Postgres is reachable; skipped otherwise.
const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip

const GIB = 1024 * 1024 * 1024
const REGION_ID = 'sgp-a'
// A schema of this suite's own, the way job.service.claim.integration.spec.ts and
// box-activity.service.integration.spec.ts each take one. Rebuilding `public` instead
// would tear down whatever another suite is running in the same database, and jest
// serializes nothing here.
const schemaName = `admin_overview_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('Admin overview projections (integration, real Postgres)', () => {
  let dataSource: DataSource
  let platform: AdminPlatformOverviewService
  let organizations: AdminOrganizationOverviewService
  let organizationId: string
  let ownsSchema = false

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      // Every entity, because the services read across five modules and TypeORM
      // needs each relation target it meets on the way.
      entities: [join(__dirname, '../../**/*.entity.ts')],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      // Enum column defaults and partial-index predicates reach the DDL with their casts
      // unqualified (`'unknown'::box_state_enum`), so this run's schema has to be on the
      // search_path for synchronize() to build them here — the same reason
      // box-activity.service.integration.spec.ts sets it.
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    // uuid-ossp is database-wide, so it is created rather than dropped: another suite's
    // schema in this database may already depend on it.
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()

    await dataSource.getRepository(Region).insert({
      id: REGION_ID,
      name: 'Singapore',
      regionType: RegionType.SHARED,
      enforceQuotas: false,
    })
    const runner = await dataSource.getRepository(Runner).insert({
      region: REGION_ID,
      name: 'runner-1',
      apiKey: 'runner-key',
      apiVersion: '0',
      state: RunnerState.READY,
      cpu: 4,
      memoryGiB: 8,
    })
    const runnerId = runner.identifiers[0].id as string
    const organization = await dataSource
      .getRepository(Organization)
      .insert({ name: 'Acme', createdBy: '00000000-0000-4000-8000-0000000000ff' })
    organizationId = organization.identifiers[0].id as string

    const box = (id: string, name: string, state: BoxState, desiredState: BoxDesiredState) => ({
      id,
      organizationId,
      name,
      region: REGION_ID,
      osUser: 'root',
      authToken: `token-${id}`,
      state,
      desiredState,
    })
    await dataSource
      .getRepository(Box)
      .insert([
        box('box-healthy1', 'healthy', BoxState.STARTED, BoxDesiredState.STARTED),
        box('box-broken01', 'broken', BoxState.ERROR, BoxDesiredState.STARTED),
        box('box-archive1', 'archived', BoxState.ARCHIVED, BoxDesiredState.STOPPED),
      ])
    // Explicit ids whose ascending order is deliberately not their chronological order,
    // so a page ordered by id is distinguishable from one ordered newest-first.
    const job = (id: string, createdAt: string, status: JobStatus) => ({
      id,
      version: 1,
      type: JobType.START_BOX,
      status,
      runnerId,
      resourceType: ResourceType.BOX,
      resourceId: 'box-healthy1',
      createdAt: new Date(createdAt),
      ...(status === JobStatus.PENDING ? {} : { completedAt: new Date(createdAt) }),
    })
    await dataSource
      .getRepository(Job)
      .insert([
        job('00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z', JobStatus.COMPLETED),
        job('00000000-0000-4000-8000-000000000002', '2026-01-03T00:00:00Z', JobStatus.PENDING),
        job('00000000-0000-4000-8000-000000000003', '2026-01-02T00:00:00Z', JobStatus.COMPLETED),
      ])

    // job."createdAt" is `TIMESTAMP WITH TIME ZONE` defaulted to now(), so every job the
    // API creates carries microseconds. A JS Date cannot hold them, so these rows are
    // written as SQL literals — inserting them through the repository would round-trip
    // them through the very truncation under test.
    for (const [id, createdAt] of [
      ['00000000-0000-4000-8000-00000000000a', '2026-02-01T00:00:00.500900Z'],
      ['00000000-0000-4000-8000-00000000000b', '2026-02-01T00:00:00.500100Z'],
      ['00000000-0000-4000-8000-00000000000c', '2026-02-01T00:00:00.400000Z'],
    ]) {
      await dataSource.query(
        `INSERT INTO "job" ("id", "version", "type", "status", "runnerId", "resourceType", "resourceId", "createdAt", "completedAt")
         VALUES ($1, 1, $2, $3, $4, $5, 'box-broken01', $6::timestamptz, $6::timestamptz)`,
        [id, JobType.START_BOX, JobStatus.COMPLETED, runnerId, ResourceType.BOX, createdAt],
      )
    }

    platform = new AdminPlatformOverviewService(
      dataSource.getRepository(Region),
      dataSource.getRepository(Runner),
      dataSource.getRepository(Box),
      dataSource.getRepository(Job),
    )
    organizations = new AdminOrganizationOverviewService(
      dataSource.getRepository(Organization),
      dataSource.getRepository(OrganizationUser),
      dataSource.getRepository(User),
      dataSource.getRepository(Box),
      dataSource.getRepository(BoxUsagePeriod),
    )
  }, 60_000)

  // Only the schema this suite created, so a failure before CREATE SCHEMA never drops
  // one belonging to somebody else. Nothing outside it is touched, which is what makes
  // the suite re-runnable and safe beside other integration suites in the same database.
  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }

    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  it('counts a region fleet, its queued jobs, and its active boxes', async () => {
    const page = await platform.regions({ limit: 50 })

    expect(page.items).toEqual([
      expect.objectContaining({
        id: REGION_ID,
        state: 'critical',
        runnerCount: 1,
        // The archived box holds no capacity, so it is not one of them.
        boxCount: 2,
        queueDepth: 1,
        cpuCapacityMillis: 4000,
        memoryCapacityBytes: String(8 * GIB),
      }),
    ])
  })

  // An operator opens a box to find out what just happened to it, so the first page has to
  // be the jobs that just happened. Ordering by a random v4 uuid makes page one an
  // arbitrary sample of the box's whole history, and AdminBoxJobReferenceDto carries no
  // timestamp for the caller to re-sort by.
  it('returns a box its newest jobs first and walks backwards through them', async () => {
    const firstPage = await platform.box('box-healthy1', { jobLimit: 2 })

    expect(firstPage?.jobs.items.map((item) => item.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ])

    const secondPage = await platform.box('box-healthy1', {
      jobLimit: 2,
      jobCursor: firstPage?.jobs.nextCursor as string,
    })

    expect(secondPage?.jobs.items.map((item) => item.id)).toEqual(['00000000-0000-4000-8000-000000000001'])
    expect(secondPage?.jobs.nextCursor).toBeNull()
  })

  // A cursor built from a JS Date carries milliseconds, while the column it seeks into
  // holds microseconds. Two jobs created in the same millisecond straddle that boundary:
  // the second one sorts after the cursor's own row but before the truncated cursor, so a
  // keyset seek that compares against the untruncated column steps straight over it.
  it('loses no job when two of them share a millisecond', async () => {
    const walked: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const result = await platform.box('box-broken01', { jobLimit: 1, jobCursor: cursor })
      walked.push(...(result?.jobs.items.map((item) => item.id) ?? []))
      cursor = result?.jobs.nextCursor ?? undefined
      if (!cursor) break
    }

    // Within the shared millisecond the tie-break is the id, so ...000b precedes ...000a
    // even though it was stored 800 microseconds earlier.
    expect(walked).toEqual([
      '00000000-0000-4000-8000-00000000000b',
      '00000000-0000-4000-8000-00000000000a',
      '00000000-0000-4000-8000-00000000000c',
    ])
  })

  it('counts an organization fleet and names the boxes that are off their desired state', async () => {
    const page = await organizations.list({ limit: 50 })
    expect(page.items).toEqual([
      expect.objectContaining({ organizationId, memberCount: 0, boxCount: 2, impactState: 'impacted' }),
    ])

    const detail = await organizations.detail(organizationId, { memberLimit: 50, boxLimit: 50 })

    expect(detail?.boxes.items.map((item) => item.id)).toEqual(['box-broken01', 'box-healthy1'])
    expect(detail?.impact).toEqual({
      state: 'impacted',
      evidence: [expect.objectContaining({ boxId: 'box-broken01', summary: 'broken: error (desired started)' })],
    })
    expect(detail?.usage).toEqual(expect.objectContaining({ computeSeconds: '0', storageByteSeconds: '0' }))
  })
})
