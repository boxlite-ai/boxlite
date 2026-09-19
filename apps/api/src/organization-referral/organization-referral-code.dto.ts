import { ApiProperty } from '@nestjs/swagger'

export class OrganizationReferralCodeDto {
  @ApiProperty({ format: 'uuid' })
  organizationId: string

  @ApiProperty({ pattern: '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$', minLength: 10, maxLength: 10 })
  referralCode: string
}
