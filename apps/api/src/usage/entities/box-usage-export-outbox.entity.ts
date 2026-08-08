/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

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
 */
@Entity('box_usage_export_outbox')
@Index('box_usage_export_outbox_pending_idx', ['status', 'availableAt'], { where: `"status" = 'pending'` })
export class BoxUsageExportOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /**
   * Deterministic identity of the usage fact, derived from the interval and its
   * resources. Unique, which is what makes enqueue idempotent and lets the
   * archive backfill run repeatedly without duplicating work.
   */
  @Column({ unique: true })
  eventKey: string

  /**
   * The exact message, built once at enqueue and never re-derived.
   *
   * Quantities are not stored as `numeric` and re-serialized at send time: the
   * Postgres driver returns `numeric` as a string, so a key computed from the
   * entity ("2") and one computed from a round-tripped column ("2.000000000000")
   * would differ, and two identities for one fact double-bill the customer.
   */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>

  @Column({ type: 'int' })
  schemaVersion: number

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

  // Denormalized for querying and diagnostics only — never the source of the
  // message. Null on a blocked row, whose source data failed validation and so
  // has nothing trustworthy to copy here; its detail lives in `payload`.

  @Column({ nullable: true })
  organizationId: string | null

  @Column({ name: 'boxId', nullable: true })
  boxId: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  startAt: Date | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  endAt: Date | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
