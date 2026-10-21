import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'AdminOrganizationActivation' })
export class AdminOrganizationActivationDto {
  @ApiProperty({ format: 'uuid' })
  organizationId: string

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Maximum retained Box creation or warm-pool claim time; survives Box deletion.',
  })
  lastBoxCreatedAt: string | null

  @ApiProperty({
    description: 'Whether creation, successful start and accepted deletion tracking covers the organization lifetime.',
  })
  boxHistoryComplete: boolean

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'Maximum observed successful-start or accepted-deletion time; cleanup, stops and label edits do not advance it.',
  })
  lastBoxModifiedAt: string | null

  @ApiProperty({ format: 'date-time' })
  observedAt: string
}
