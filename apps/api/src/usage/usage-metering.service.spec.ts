/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UsagePeriodArchive } from './entities/usage-period-archive.entity'
import { UsagePeriod } from './entities/usage-period.entity'
import { UsageMeteringService } from './usage-metering.service'

class FakeRepository<T> {
  constructor(readonly rows: T[]) {}

  async find(): Promise<T[]> {
    return this.rows
  }
}

describe('UsageMeteringService', () => {
  it('aggregates current and archived Box usage without changing the Daytona writer', async () => {
    const active = {
      id: 'period-open',
      boxId: 'box-1',
      organizationId: 'org-1',
      region: 'us',
      startAt: new Date('2026-07-08T00:00:00Z'),
      endAt: null,
      kind: 'running',
      cpu: 2,
      mem: 4,
      disk: 10,
      gpu: 1,
      actualCpuSeconds: null,
      actualRssAvgBytes: null,
      actualRssPeakBytes: null,
      sampleCount: null,
    } as UsagePeriod
    const archived = {
      id: 'archive-1',
      sourcePeriodId: 'period-closed',
      boxId: 'box-2',
      organizationId: 'org-1',
      region: 'us',
      startAt: new Date('2026-07-07T23:00:00Z'),
      endAt: new Date('2026-07-08T00:00:00Z'),
      kind: 'stopped',
      cpu: 0,
      mem: 0,
      disk: 20,
      gpu: 0,
      actualCpuSeconds: null,
      actualRssAvgBytes: null,
      actualRssPeakBytes: null,
      sampleCount: null,
    } as UsagePeriodArchive
    const service = new UsageMeteringService(
      new FakeRepository([active]) as never,
      new FakeRepository([archived]) as never,
    )

    const view = await service.getOrganizationMeteringView(
      'org-1',
      {
        from: new Date('2026-07-07T23:00:00Z'),
        to: new Date('2026-07-08T01:00:00Z'),
        limit: 10,
      },
      new Date('2026-07-08T01:00:00Z'),
    )

    expect(view.totals).toEqual({
      cpuSeconds: 7200,
      memGibSeconds: 14400,
      diskGibSeconds: 108000,
      gpuSeconds: 3600,
    })
    expect(view.activePeriods[0]).toMatchObject({ source: 'box_usage_period', active: true })
    expect(view.archivedPeriods[0]).toMatchObject({ source: 'box_usage_period_archive', active: false })
  })
})
