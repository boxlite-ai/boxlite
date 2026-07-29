/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'
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

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date
}
