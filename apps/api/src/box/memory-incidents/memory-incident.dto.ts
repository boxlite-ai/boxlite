import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'

const timestampWithTimezone = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/

export class BoxMemoryUsageDto {
  @ApiProperty({ description: 'Business Box ID.' })
  @Matches(/^[A-Za-z0-9_-]{1,128}$/)
  boxId: string

  @ApiProperty({ description: 'Exact image reference from the same Box snapshot; empty is preserved.' })
  @IsString()
  image: string

  @ApiProperty({ type: String, description: 'Current bytes as a decimal string, between 0 and 9223372036854775807.' })
  @Matches(/^(0|[1-9][0-9]*)$/)
  @MaxLength(19)
  memoryBytes: string
}

export class RunnerMemoryIncidentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  eventId: string

  @ApiProperty({
    format: 'date-time',
    description: 'Host sample time, with timezone and at most millisecond precision.',
  })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestampWithTimezone)
  sampledAt: string

  @ApiProperty({ description: 'Host memory percent, strictly above 80 and at most 100.' })
  @IsNumber()
  @Min(80)
  @Max(100)
  runnerMemoryPercent: number

  @ApiProperty({
    type: [BoxMemoryUsageDto],
    maxItems: 5,
    description: 'Descending current bytes, then Box ID ascending; empty when none readable.',
  })
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique((box: BoxMemoryUsageDto) => box?.boxId)
  @ValidateNested({ each: true })
  @Type(() => BoxMemoryUsageDto)
  boxes: BoxMemoryUsageDto[]

  @ApiProperty({ description: 'False if any running Box could not be attributed.' })
  @IsBoolean()
  samplingComplete: boolean
}

export class ListMemoryIncidentsDto {
  @ApiProperty({ type: String, format: 'date-time', description: 'Inclusive host sample time, with timezone.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestampWithTimezone)
  from: string

  @ApiProperty({ type: String, format: 'date-time', description: 'Exclusive host sample time, after from.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(timestampWithTimezone)
  to: string

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 200,
    default: 50,
    description: 'Maximum snapshots after per-Box maximum memory selection, ordered by ID ascending.',
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
