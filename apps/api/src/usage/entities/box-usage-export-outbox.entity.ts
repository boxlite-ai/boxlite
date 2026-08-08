/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

/**
 * There is deliberately no `delivering` state. A status that a crashed worker
 * can leave behind strands the row forever, which loses usage silently — the
 * one failure direction billing cannot tolerate. Claiming instead pushes
 * `availableAt` forward, so a crashed worker's row simply becomes claimable
 * again and the duplicate delivery that may cause is absorbed downstream.
 */
export enum UsageExportStatus {
  PENDING = 'pending',
  DELIVERED = 'delivered',
  BLOCKED = 'blocked',
}

/**
 * Transactional outbox for finalized usage periods.
 *
 * A row is written in the same transaction that archives the period it
 * describes, so a usage fact can never be archived without an export intent,
 * and an intent can never survive a rolled-back archive. Progress is recorded
 * per row rather than as a watermark: neither usage table has a monotonic
 * column, and adding one would not help, because Postgres sequences can commit
 * out of order and a `seq > cursor` reader would silently skip rows.
 *
 * Only the queue state lives in columns. Everything describing the usage itself
 * stays inside `payload`, which is the message — duplicating those fields
 * alongside it bought nothing but a second copy to keep honest.
 */
@Entity('box_usage_export_outbox')
@Index('box_usage_export_outbox_pending_idx', ['status', 'availableAt'], { where: `"status" = 'pending'` })
export class BoxUsageExportOutbox {
  /**
   * Deterministic identity of the usage fact, derived from the interval and its
   * resources. It is the natural key, so it is the primary key: a surrogate id
   * beside it would be a second identity for one row, and every lookup here is
   * by this value or by queue state.
   */
  @PrimaryColumn()
  eventKey: string

  /**
   * The exact message, built once at enqueue and never re-derived.
   *
   * Deriving it at send time instead would mean any later change to the key
   * fields silently re-identified rows that were enqueued but not yet
   * delivered, and Commerce deduplicates on that identity.
   */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>

  @Column({ type: 'varchar', length: 16, default: UsageExportStatus.PENDING })
  status: UsageExportStatus

  @Column({ type: 'int', default: 0 })
  attempts: number

  /** Not claimable until this instant — both the retry backoff and the claim visibility timeout. */
  @Column({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  availableAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  deliveredAt: Date | null

  @Column({ type: 'text', nullable: true })
  lastError: string | null
}
