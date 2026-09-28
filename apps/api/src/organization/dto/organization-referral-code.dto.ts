import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'OrganizationReferralCode' })
export class OrganizationReferralCodeDto {
  @ApiProperty({ format: 'uuid' })
  organizationId: string

  @ApiProperty({ pattern: '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$', minLength: 10, maxLength: 10, example: '7KMNP4XZQ2' })
  referralCode: string
}
