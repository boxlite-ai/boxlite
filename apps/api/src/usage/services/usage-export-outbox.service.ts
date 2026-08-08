/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, LessThan, Repository } from 'typeorm'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxUsageExportOutbox, UsageExportStatus } from '../entities/box-usage-export-outbox.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import {
  blockedUsageEventKey,
  FinalizedUsagePeriod,
  InvalidUsagePeriodError,
  toUsageEventDto,
  usagePeriodSnapshot,
} from '../usage-event'

/**
 * Writes finalized usage periods into the export outbox.
 *
 * `enqueue` runs inside the caller's transaction so an export intent and the
 * archive row it describes commit together. It is idempotent: identity comes
 * from the interval rather than the row id, so re-archiving the same usage
 * resolves to the row that is already there.
 */
@Injectable()
export class UsageExportOutboxService {
  private readonly logger = new Logger(UsageExportOutboxService.name)

  constructor(
    @InjectRepository(BoxUsageExportOutbox)
    private readonly outboxRepository: Repository<BoxUsageExportOutbox>,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * Records an export intent for each finalized period, in the caller's
   * transaction.
   *
   * Returns the number of rows the insert actually created; a period already
   * enqueued contributes nothing, which is what makes a retried archive cycle
   * harmless.
   *
   * Malformed source data becomes a durable blocked row rather than an
   * exception. Throwing would abort the caller's transaction, and that
   * transaction archives every closed period in one batch ordered by `startAt`
   * — so one unparseable row sorts early, sits in every batch, and wedges
   * archiving, and therefore all export, permanently. `NOT NULL` on the source
   * columns does not make this unreachable: they are `double precision`, which
   * accepts `NaN`, and `endAt < startAt` follows from ordinary clock skew
   * between the replicas that write the two timestamps.
   */
  async enqueue(entityManager: EntityManager, periods: BoxUsagePeriod[]): Promise<number> {
    if (!this.configService.get('usageExport.enabled')) {
      return 0
    }

    const closed = periods.filter((period) => period.endAt !== null)
    const billable = closed.filter((period) => period.organizationId !== BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
    if (billable.length < closed.length) {
      this.logger.debug(`Skipped ${closed.length - billable.length} warm-pool usage periods`)
    }
    if (billable.length === 0) {
      return 0
    }

    const rows = billable.map((period) => this.toRow(period))

    const inserted = await entityManager
      .createQueryBuilder()
      .insert()
      .into(BoxUsageExportOutbox)
      .values(rows)
      .orIgnore()
      .execute()

    // `raw` is what RETURNING actually produced, so it counts rows the conflict
    // clause let through. `identifiers` cannot: the event key is supplied rather
    // than generated, so TypeORM echoes it back for skipped rows too and every
    // insert would look like it landed.
    return Array.isArray(inserted.raw) ? inserted.raw.length : 0
  }

  /**
   * One period as an outbox row. A blocked row keeps the offending values as a
   * diagnostic snapshot and is never delivered, so the batch around it still
   * commits.
   *
   * Only bad source data is caught here. A database or programming fault must
   * keep failing as itself, or a broken exporter would quietly mark real usage
   * unexportable.
   */
  private toRow(period: BoxUsagePeriod): Partial<BoxUsageExportOutbox> {
    try {
      const event = toUsageEventDto(period as FinalizedUsagePeriod)
      return { eventKey: event.eventKey, payload: { ...event }, status: UsageExportStatus.PENDING }
    } catch (error) {
      if (!(error instanceof InvalidUsagePeriodError)) {
        throw error
      }
      this.logger.error(`Usage period ${period.id} cannot be exported: ${error.message}`)
      return {
        eventKey: blockedUsageEventKey(period.id),
        payload: usagePeriodSnapshot(period),
        status: UsageExportStatus.BLOCKED,
        lastError: error.message,
      }
    }
  }

  /** Drops delivered history past the retention window. Never touches pending or blocked rows. */
  async pruneDelivered(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const deleted = await this.outboxRepository.delete({
      status: UsageExportStatus.DELIVERED,
      deliveredAt: LessThan(cutoff),
    })
    return deleted.affected ?? 0
  }
}
