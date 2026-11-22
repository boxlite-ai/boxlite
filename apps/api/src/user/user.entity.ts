/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'
import type { RegistrationSource } from './registration-source'
import { SystemRole } from './enums/system-role.enum'

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

  @Column('simple-json')
  publicKeys: UserPublicKey[]

  @Column({
    type: 'enum',
    enum: SystemRole,
    default: SystemRole.USER,
  })
  role: SystemRole

  @Column({ type: 'jsonb', nullable: true, update: false, select: false })
  registrationSource?: RegistrationSource | null

  @CreateDateColumn({
    type: 'timestamp with time zone',
  })
  createdAt: Date
}
