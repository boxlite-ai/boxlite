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
import { BoxUsagePeriodArchive } from '../entities/box-usage-period-archive.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import {
  blockedUsageEventKey,
  FinalizedUsagePeriod,
  InvalidUsagePeriodError,
  toUsageEventDto,
  usagePeriodSnapshot,
  USAGE_EXPORT_SCHEMA_VERSION,
} from '../usage-event'

/** A closed usage period plus the row id used to identify malformed source data. */
type ExportableUsagePeriod = (BoxUsagePeriod | BoxUsagePeriodArchive) & { id: string }

export interface UsageBackfillResult {
  scanned: number
  enqueued: number
}

/**
 * Writes finalized usage periods into the export outbox.
 *
 * `enqueue` runs inside the caller's transaction so an export intent and the
 * archive row it describes commit together. Both entry points are idempotent:
 * identity comes from the interval, not the row id, so the live path and the
 * archive backfill converge on one row per usage fact instead of exporting it
 * twice.
 */
@Injectable()
export class UsageExportOutboxService {
  private readonly logger = new Logger(UsageExportOutboxService.name)

  constructor(
    @InjectRepository(BoxUsageExportOutbox)
    private readonly outboxRepository: Repository<BoxUsageExportOutbox>,
    @InjectRepository(BoxUsagePeriodArchive)
    private readonly archiveRepository: Repository<BoxUsagePeriodArchive>,
    private readonly configService: TypedConfigService,
  ) {}

  /**
   * Records an export intent for each finalized period, in the caller's
   * transaction.
   *
   * Returns the number of rows the insert actually created; a period already
   * enqueued contributes nothing, which is what makes a retried archive cycle
   * harmless.
   */
  async enqueue(entityManager: EntityManager, periods: BoxUsagePeriod[]): Promise<number> {
    if (!this.configService.get('usageExport.enabled')) {
      return 0
    }

    const closed = periods.filter((period) => period.endAt !== null)
    const billable = this.excludeWarmPool(closed)
    if (billable.length < closed.length) {
      this.logger.debug(`Skipped ${closed.length - billable.length} warm-pool usage periods`)
    }

    return this.insertRows(entityManager, billable as ExportableUsagePeriod[])
  }

  /**
   * Enqueues archived periods that predate this exporter.
   *
   * Walks by `(startAt, id)` keyset rather than a watermark cursor, and relies
   * on the unique event key rather than on where it stopped, so it stays
   * correct when run repeatedly or alongside the live path.
   */
  async backfill(): Promise<UsageBackfillResult> {
    const pageSize = this.configService.get('usageExport.backfillPageSize')
    const result: UsageBackfillResult = { scanned: 0, enqueued: 0 }
    let cursor: { startAt: Date; id: string } | null = null

    for (;;) {
      const page = await this.readArchivePage(cursor, pageSize)
      if (page.length === 0) {
        return result
      }

      result.scanned += page.length
      result.enqueued += await this.insertRows(
        this.outboxRepository.manager,
        this.excludeWarmPool(page as ExportableUsagePeriod[]),
      )

      const last = page[page.length - 1]
      cursor = { startAt: last.startAt, id: last.id }
    }
  }

  /**
   * Keyset page over the archive.
   *
   * `startAt` alone is not unique, so ties are broken by id; TypeORM has no
   * composite-cursor helper, hence the explicit predicate.
   */
  private async readArchivePage(
    cursor: { startAt: Date; id: string } | null,
    pageSize: number,
  ): Promise<BoxUsagePeriodArchive[]> {
    const query = this.archiveRepository
      .createQueryBuilder('archive')
      .orderBy('archive.startAt', 'ASC')
      .addOrderBy('archive.id', 'ASC')
      .take(pageSize)

    if (cursor) {
      query.where('(archive."startAt", archive."id") > (:startAt, :id)', {
        startAt: cursor.startAt,
        id: cursor.id,
      })
    }

    return query.getMany()
  }

  private excludeWarmPool<T extends { organizationId: string }>(periods: T[]): T[] {
    return periods.filter((period) => period.organizationId !== BOX_WARM_POOL_UNASSIGNED_ORGANIZATION)
  }

  private async insertRows(entityManager: EntityManager, periods: ExportableUsagePeriod[]): Promise<number> {
    const rows = this.deduplicate(periods.map((period) => this.toRow(period)))
    if (rows.length === 0) {
      return 0
    }

    const inserted = await entityManager
      .createQueryBuilder()
      .insert()
      .into(BoxUsageExportOutbox)
      .values(rows)
      .orIgnore()
      .execute()

    return inserted.identifiers.filter(Boolean).length
  }

  /**
   * Two zero-duration periods for one box can share an event key. They carry no
   * billable time, so collapsing them is correct — but they must not reach one
   * INSERT twice, where only the conflict clause would save them.
   */
  private deduplicate(rows: Partial<BoxUsageExportOutbox>[]): Partial<BoxUsageExportOutbox>[] {
    const byEventKey = new Map<string, Partial<BoxUsageExportOutbox>>()
    for (const row of rows) {
      if (!byEventKey.has(row.eventKey)) {
        byEventKey.set(row.eventKey, row)
      }
    }
    return [...byEventKey.values()]
  }

  /**
   * Malformed source data becomes a durable blocked row rather than an
   * exception. Throwing here would abort the caller's archive transaction, so
   * one unparseable period would wedge archiving — and therefore all billing
   * export — indefinitely. Blocked rows are never delivered and never dropped.
   */
  private toRow(period: ExportableUsagePeriod): Partial<BoxUsageExportOutbox> {
    try {
      const event = toUsageEventDto(period as FinalizedUsagePeriod)
      return {
        eventKey: event.eventKey,
        payload: { ...event },
        schemaVersion: event.schemaVersion,
        status: UsageExportStatus.PENDING,
        organizationId: period.organizationId,
        boxId: period.boxId,
        startAt: period.startAt,
        endAt: period.endAt,
      }
    } catch (error) {
      if (!(error instanceof InvalidUsagePeriodError)) {
        throw error
      }
      this.logger.error(`Usage period ${period.id} cannot be exported: ${error.message}`)
      return {
        eventKey: blockedUsageEventKey(period.id),
        payload: usagePeriodSnapshot(period),
        schemaVersion: USAGE_EXPORT_SCHEMA_VERSION,
        status: UsageExportStatus.BLOCKED,
        lastError: error.message,
      }
    }
  }

  /** Oldest still-undelivered row, used to surface a stalled exporter. */
  async oldestPendingAt(): Promise<Date | null> {
    const oldest = await this.outboxRepository.findOne({
      where: { status: UsageExportStatus.PENDING },
      order: { createdAt: 'ASC' },
    })
    return oldest?.createdAt ?? null
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
