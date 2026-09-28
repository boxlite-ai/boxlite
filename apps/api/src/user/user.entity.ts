/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm'
import { SystemRole } from './enums/system-role.enum'

/**
 * @deprecated Orphaned when the SSH gateway was removed — nothing reads the
 * generated keys. Scheduled for removal in a future release, together with the
 * `User.keyPair` column and the regenerate-key-pair endpoint.
 */
export interface UserSSHKeyPair {
  privateKey: string
  publicKey: string
}

export interface UserPublicKey {
  key: string
  name: string
}

@Index('user_referred_by_organization_idx', ['referredByOrganizationId'], {
  where: '"referredByOrganizationId" IS NOT NULL',
})
@Entity()
export class User {
  @PrimaryColumn()
  id: string

  @Column()
  name: string

  @Column({
    default: '',
  })
  email: string

  @Column({
    default: false,
  })
  emailVerified: boolean

  /**
   * @deprecated Written on user creation and by regenerateKeyPair, read by
   * nothing. Scheduled for removal in a future release.
   */
  @Column({
    type: 'simple-json',
    nullable: true,
  })
  keyPair: UserSSHKeyPair

  @Column('simple-json')
  publicKeys: UserPublicKey[]

  @Column({
    type: 'enum',
    enum: SystemRole,
    default: SystemRole.USER,
  })
  role: SystemRole

  /**
   * The organization whose invitation created this account; null otherwise.
   * No FK: organizations are hard-deleted, and the attribution must outlive them.
   */
  @Column({ type: 'uuid', nullable: true })
  referredByOrganizationId: string | null

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date
}
