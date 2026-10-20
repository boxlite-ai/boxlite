import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'AdminOrganizationActivation' })
export class AdminOrganizationActivationDto {
  @ApiProperty({ format: 'uuid' })
  organizationId: string

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Earliest retained creation or warm-pool claim; a true first only when boxHistoryComplete is true.',
  })
  firstObservedBoxCreatedAt: string | null

  @ApiProperty({ description: 'False for older organizations and organizations receiving transferred Boxes.' })
  boxHistoryComplete: boolean

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Earliest recorded positive-CPU allocation period. Null does not prove no execution.',
  })
  firstRecordedComputeAt: string | null

  @ApiProperty({ type: Boolean, enum: [false], description: 'Always false: usage events can have historical gaps.' })
  computeHistoryComplete: false

  @ApiProperty({ format: 'date-time' })
  observedAt: string
}
