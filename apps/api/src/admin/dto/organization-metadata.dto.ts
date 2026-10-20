import { ApiProperty, ApiSchema, IntersectionType } from '@nestjs/swagger'
import { AdminCursorPageDto, AdminOrganizationDetailDto, AdminOrganizationOverviewDto } from './provider-overview.dto'

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
class AdminOrganizationRegistrationDto {
  @ApiProperty({ format: 'date-time', description: 'Organization creation time, at millisecond precision.' })
  createdAt: string

  @ApiProperty({ description: 'Stored creator ID; account linking replaces it with the primary user ID.' })
  createdBy: string

  @ApiProperty({ type: AdminOrganizationCreatorDto, nullable: true })
  creator: AdminOrganizationCreatorDto | null
}

@ApiSchema({ name: 'AdminOrganizationMetadataSummary' })
class AdminOrganizationMetadataSummaryDto extends IntersectionType(
  AdminOrganizationOverviewDto,
  AdminOrganizationRegistrationDto,
) {}

@ApiSchema({ name: 'AdminOrganizationMetadataPage' })
export class AdminOrganizationMetadataPageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminOrganizationMetadataSummaryDto] })
  items: AdminOrganizationMetadataSummaryDto[]

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  observedAt: string | null
}

@ApiSchema({ name: 'AdminOrganizationMetadata' })
class AdminOrganizationMetadataDto extends IntersectionType(
  AdminOrganizationDetailDto,
  AdminOrganizationRegistrationDto,
) {}

@ApiSchema({ name: 'AdminOrganizationMetadataResult' })
export class AdminOrganizationMetadataResultDto {
  @ApiProperty({
    type: AdminOrganizationMetadataDto,
    nullable: true,
    description: 'Null means the organization does not exist. Usage is included only when explicitly requested.',
  })
  item: AdminOrganizationMetadataDto | null
}
