import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'AdminOrganizationCreator' })
class AdminOrganizationCreatorDto {
  @ApiProperty()
  userId: string

  @ApiProperty({
    type: String,
    format: 'email',
    nullable: true,
    description: 'Current email, not necessarily the email at registration.',
  })
  email: string | null

  @ApiProperty()
  displayName: string
}

@ApiSchema({ name: 'AdminOrganizationRegistration' })
export class AdminOrganizationRegistrationDto {
  @ApiProperty({ format: 'date-time', description: 'Organization creation time.' })
  createdAt: string

  @ApiProperty({
    description: 'Stored creator ID; account linking replaces it with the primary user ID.',
  })
  createdBy: string

  @ApiProperty({
    type: AdminOrganizationCreatorDto,
    nullable: true,
    description: 'Current creator identity.',
  })
  creator: AdminOrganizationCreatorDto | null
}

@ApiSchema({ name: 'AdminOrganizationVerifiedCreator' })
class AdminOrganizationVerifiedCreatorDto extends AdminOrganizationCreatorDto {
  @ApiPropertyOptional({ description: 'Current verification state from the creator account.' })
  emailVerified?: boolean
}

// List readers expose verification without expanding the existing detail contract.
export class AdminOrganizationVerifiedRegistrationDto extends AdminOrganizationRegistrationDto {
  @ApiProperty({
    type: AdminOrganizationVerifiedCreatorDto,
    nullable: true,
    description: 'Current creator identity.',
  })
  declare creator: AdminOrganizationVerifiedCreatorDto | null
}
