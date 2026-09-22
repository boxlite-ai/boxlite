import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm'

export interface InvitationRegistrationSucceeded {
  eventId: string
  type: 'InvitationRegistrationSucceeded'
  occurredAt: string
  data: { registrationId: string; inviteeUserId: string }
}

@Entity('organization_business_event_outbox')
@Index('business_event_outbox_pending_idx', ['status', 'availableAt'], { where: `"status" = 'pending'` })
export class BusinessEventOutbox {
  @PrimaryColumn('uuid')
  eventId: string

  @Column('uuid')
  organizationId: string

  @Column('jsonb')
  payload: InvitationRegistrationSucceeded

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: 'pending' | 'delivered' | 'blocked'

  @Column({ type: 'int', default: 0 })
  attempts: number

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  availableAt: Date

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null

  @Column({ type: 'text', nullable: true })
  lastError: string | null

  @Column({ type: 'uuid', nullable: true })
  claimToken: string | null

  @Column({ type: 'jsonb', nullable: true })
  responseSnapshot: Record<string, unknown> | null
}
