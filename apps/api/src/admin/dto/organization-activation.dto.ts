import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'AdminOrganizationActivation' })
export class AdminOrganizationActivationDto {
  @ApiProperty({ format: 'uuid' })
  organizationId: string

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'Maximum retained Box creation or warm-pool claim time; survives Box deletion. Null means none was recorded; organizations older than tracking only have retained creation times.',
  })
  lastBoxCreatedAt: string | null

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'Maximum observed successful-start or accepted-deletion time; cleanup, stops and label edits do not advance it. Null means none was recorded since tracking began.',
  })
  lastBoxModifiedAt: string | null

  @ApiProperty({ format: 'date-time' })
  observedAt: string
}
