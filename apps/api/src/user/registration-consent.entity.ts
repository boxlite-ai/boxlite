/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm'

export interface AcceptedLegalVersions {
  tosVersion: string
  privacyVersion: string
}

@Entity('registration_consent')
@Unique('registration_consent_user_id_unique', ['userId'])
export class RegistrationConsent implements AcceptedLegalVersions {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ name: 'user_id' })
  userId: string

  @Column({ name: 'accepted_by_user_id', type: 'varchar', nullable: true })
  acceptedByUserId: string | null

  @Column({ name: 'tos_version', type: 'text' })
  tosVersion: string

  @Column({ name: 'privacy_version', type: 'text' })
  privacyVersion: string

  @CreateDateColumn({ name: 'accepted_at', type: 'timestamptz' })
  acceptedAt: Date
}
