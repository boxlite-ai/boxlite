/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity('payment_provider_event')
@Index('payment_provider_event_provider_id_idx', ['providerEventId'], { unique: true })
export class PaymentProviderEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'character varying' })
  providerEventId: string

  @Column({ type: 'character varying' })
  eventType: string

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
