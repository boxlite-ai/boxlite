import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator'

const timestampWithTimezone = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/

export class RunnerCpuIncidentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  eventId: string

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  highCpuSince: string

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  windowStartedAt: string

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  windowEndedAt: string

  @ApiProperty({ description: 'Host-wide CPU percent at trigger, strictly above 80.' })
  @IsNumber()
  @Min(80)
  @Max(100)
  runnerCpuPercent: number

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Business box ID of the largest measured consumer, or null.',
  })
  @ValidateIf((_, value) => value !== null)
  @Matches(/^[A-Za-z0-9_-]{1,128}$/)
  boxId: string | null

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Winning box Image string from the runner snapshot.',
  })
  @IsOptional()
  @IsString()
  image?: string | null

  @ApiProperty({ description: 'Measured CPU-seconds in the capture window, across all cores.' })
  @IsNumber()
  @Min(0)
  @Max(1e12)
  cpuSeconds: number

  @ApiProperty({ description: 'False when any attribution sample was missing or counters changed identity.' })
  @IsBoolean()
  samplingComplete: boolean
}

export class ListCpuIncidentsDto {
  @ApiProperty({ type: String, format: 'date-time', description: 'Inclusive capture completion time, with timezone.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestampWithTimezone)
  from: string

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Exclusive capture completion time, with timezone; must follow from.',
  })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestampWithTimezone)
  to: string

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 200,
    default: 50,
    description: 'Maximum rows, ordered by ID ascending.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  runnerId?: string
}
