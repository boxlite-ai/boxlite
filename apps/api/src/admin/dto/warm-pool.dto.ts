import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator'
import { ScheduleConfig, ScheduleWindow, WarmPool } from '../../box/entities/warm-pool.entity'

export class ScheduleWindowDto implements ScheduleWindow {
  @ApiProperty({ description: '0=Sun..6=Sat; omit for every day', required: false, type: [Number] })
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @IsOptional()
  days?: number[]

  @ApiProperty({ description: 'Start hour (0-23); omit for all day', example: 8, required: false })
  @IsInt()
  @Min(0)
  @Max(23)
  @IsOptional()
  startHour?: number

  @ApiProperty({ description: 'End hour (0-23); wraps midnight if less than startHour; omit for all day', example: 22, required: false })
  @IsInt()
  @Min(0)
  @Max(23)
  @IsOptional()
  endHour?: number

  @ApiProperty({ description: 'Target pool size for this window', example: 20 })
  @IsInt()
  @Min(0)
  pool: number
}

export class ScheduleConfigDto implements ScheduleConfig {
  @ApiProperty({ type: [ScheduleWindowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleWindowDto)
  windows: ScheduleWindowDto[]
}

@ApiSchema({ name: 'AdminUpdateWarmPoolSchedule' })
export class UpdateWarmPoolScheduleDto {
  @ApiProperty({ type: ScheduleConfigDto, nullable: true, required: false })
  @ValidateNested()
  @Type(() => ScheduleConfigDto)
  @IsOptional()
  scheduleConfig: ScheduleConfigDto | null

  @ApiProperty({ description: 'IANA timezone, e.g. Asia/Shanghai', example: 'UTC', default: 'UTC' })
  @IsString()
  timezone: string
}

@ApiSchema({ name: 'AdminWarmPool' })
export class AdminWarmPoolDto {
  @ApiProperty() id: string
  @ApiProperty() image: string
  @ApiProperty() target: string
  @ApiProperty() pool: number
  @ApiProperty() cpu: number
  @ApiProperty() mem: number
  @ApiProperty() disk: number
  @ApiProperty() gpu: number
  @ApiProperty({ nullable: true, type: ScheduleConfigDto }) scheduleConfig: ScheduleConfig | null
  @ApiProperty() timezone: string

  static fromEntity(e: WarmPool): AdminWarmPoolDto {
    const dto = new AdminWarmPoolDto()
    dto.id = e.id
    dto.image = e.image
    dto.target = e.target
    dto.pool = e.pool
    dto.cpu = e.cpu
    dto.mem = e.mem
    dto.disk = e.disk
    dto.gpu = e.gpu
    dto.scheduleConfig = e.scheduleConfig
    dto.timezone = e.timezone
    return dto
  }
}
