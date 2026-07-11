/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

export type PaymentProviderEventStatus = 'processed' | 'failed'

@Entity('payment_provider_event')
@Index('payment_provider_event_provider_id_idx', ['providerEventId'], { unique: true })
@Index('payment_provider_event_retry_due_idx', ['nextAttemptAt'], {
  where: '"status" = \'failed\' AND "nextAttemptAt" IS NOT NULL',
})
export class PaymentProviderEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'character varying' })
  providerEventId: string

  @Column({ type: 'character varying' })
  eventType: string

  @Column({ type: 'character varying', nullable: true })
  providerReference: string | null

  @Column({ type: 'character varying', default: 'processed' })
  status: PaymentProviderEventStatus

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null

  @Column({ type: 'integer', default: 1 })
  attempts: number

  @Column({ type: 'timestamp with time zone', nullable: true })
  nextAttemptAt: Date | null

  @Column({ type: 'text', nullable: true })
  lastError: string | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
