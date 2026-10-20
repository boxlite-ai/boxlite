import { ApiProperty, ApiSchema } from '@nestjs/swagger'

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
