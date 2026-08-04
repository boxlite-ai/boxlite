/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty } from '@nestjs/swagger'
import { BoxUsagePeriod } from '../../usage/entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../../usage/entities/box-usage-period-archive.entity'

/**
 * The wire shape commerce-rs's `RawPeriod` decodes (see boxlite-commerce's
 * crates/store/src/upstream/http.rs) -- field names and units are fixed by
 * that client, not by this app's own entity naming.
 */
export class BillingPeriodDto {
  @ApiProperty()
  periodId: string

  @ApiProperty()
  boxId: string

  @ApiProperty({ nullable: true })
  organizationId: string | null

  @ApiProperty()
  region: string

  @ApiProperty()
  startAt: string

  @ApiProperty({ nullable: true })
  endAt: string | null

  @ApiProperty()
  cpu: number

  @ApiProperty()
  gpu: number

  @ApiProperty()
  mem: number

  @ApiProperty()
  disk: number

  static fromArchive(period: BoxUsagePeriodArchive): BillingPeriodDto {
    return {
      periodId: period.id,
      boxId: period.boxId,
      organizationId: period.organizationId ?? null,
      region: period.region,
      startAt: period.startAt.toISOString(),
      endAt: period.endAt.toISOString(),
      cpu: period.cpu,
      gpu: period.gpu,
      mem: period.mem,
      disk: period.disk,
    }
  }

  static fromOpenPeriod(period: BoxUsagePeriod): BillingPeriodDto {
    return {
      periodId: period.id,
      boxId: period.boxId,
      organizationId: period.organizationId ?? null,
      region: period.region,
      startAt: period.startAt.toISOString(),
      endAt: period.endAt ? period.endAt.toISOString() : null,
      cpu: period.cpu,
      gpu: period.gpu,
      mem: period.mem,
      disk: period.disk,
    }
  }
}

export class BillingPeriodListDto {
  @ApiProperty({ type: [BillingPeriodDto] })
  periods: BillingPeriodDto[]
}

export class MarkBilledResultDto {
  @ApiProperty()
  marked: boolean
}
