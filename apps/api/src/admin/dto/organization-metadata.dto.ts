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
  @ApiPropertyOptional({ format: 'date-time', description: 'Organization creation time; present with view=metadata.' })
  createdAt?: string

  @ApiPropertyOptional({
    description: 'Stored creator ID with view=metadata; account linking replaces it with the primary user ID.',
  })
  createdBy?: string

  @ApiPropertyOptional({
    type: AdminOrganizationCreatorDto,
    nullable: true,
    description: 'Current creator identity with view=metadata.',
  })
  creator?: AdminOrganizationCreatorDto | null
}
