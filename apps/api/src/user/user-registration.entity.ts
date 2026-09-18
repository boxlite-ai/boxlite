import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm'

export enum RegistrationStatus {
  NONE = 'none',
  PENDING_VERIFICATION = 'pending_verification',
  ACCEPTED = 'accepted',
}

/** Immutable attribution survives deletion of users and organizations: deliberately no foreign keys. */
@Entity('user_registration')
@Check('user_registration_status_ck', `"status" IN ('none', 'pending_verification', 'accepted')`)
@Check(
  'user_registration_acceptance_ck',
  `("status" = 'accepted' AND "acceptedAt" IS NOT NULL AND "eventId" IS NOT NULL) OR ("status" <> 'accepted' AND "acceptedAt" IS NULL AND "eventId" IS NULL)`,
)
@Check(
  'user_registration_attribution_ck',
  `("status" = 'none' AND "inviterOrganizationId" IS NULL AND "referredCode" IS NULL) OR ("status" <> 'none' AND "inviterOrganizationId" IS NOT NULL AND "referredCode" IS NOT NULL)`,
)
@Unique('user_registration_user_id_uq', ['userId'])
@Unique('user_registration_event_id_uq', ['eventId'])
export class UserRegistration {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column()
  userId: string

  @Column({ type: 'uuid', nullable: true })
  defaultOrganizationId: string | null

  @Column({ type: 'uuid', nullable: true })
  inviterOrganizationId: string | null

  @Column({ type: 'varchar', length: 10, nullable: true })
  referredCode: string | null

  @Column({ type: 'varchar', length: 24 })
  status: RegistrationStatus

  @Column({ type: 'uuid', nullable: true })
  eventId: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null
}
