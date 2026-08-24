import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm'

export enum SignupCreditOutboxStatus {
  AWAITING_VERIFICATION = 'awaiting_verification',
  PENDING = 'pending',
  DELIVERED = 'delivered',
  BLOCKED = 'blocked',
  CANCELLED = 'cancelled',
}

export enum SignupCreditEligibilityKind {
  REGISTERED_VERIFIED = 'registered_verified',
  VERIFIED_LATER = 'verified_later',
}

export type SignupCreditPayload = {
  schemaVersion: 1
  amountCents: number
}

@Entity('signup_credit_outbox')
@Index('signup_credit_outbox_organization_unique', ['organizationId'], { unique: true })
@Index('signup_credit_outbox_pending_idx', ['status', 'availableAt'], { where: `"status" = 'pending'` })
export class SignupCreditOutbox {
  @PrimaryColumn()
  eventKey: string

  @Column({ type: 'uuid' })
  organizationId: string

  @Column({ type: 'jsonb' })
  payload: SignupCreditPayload

  @Column({ type: 'varchar', length: 32 })
  status: SignupCreditOutboxStatus

  @Column({ type: 'int', default: 0 })
  attempts: number

  @Column({ type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  availableAt: Date

  @Column({ type: 'timestamp with time zone', nullable: true })
  eligibleAt: Date | null

  @Column({ type: 'varchar', length: 32, nullable: true })
  eligibilityKind: SignupCreditEligibilityKind | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  deliveredAt: Date | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  cancelledAt: Date | null

  @Column({ type: 'text', nullable: true })
  lastError: string | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date
}
