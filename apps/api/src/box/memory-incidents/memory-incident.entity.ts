import { ApiProperty } from '@nestjs/swagger'
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm'
import { BoxMemoryUsageDto } from './memory-incident.dto'

@Entity('runner_memory_incident')
@Unique('runner_memory_incident_event_unique', ['runnerId', 'eventId'])
@Index('runner_memory_incident_runner_id_idx', ['runnerId', 'id'])
@Index('runner_memory_incident_sampled_at_idx', ['sampledAt'])
export class RunnerMemoryIncident {
  @ApiProperty({ type: String, description: 'Bigint row ID; keep as a string.' })
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id: string

  @ApiProperty({ format: 'uuid' })
  @Column('uuid')
  runnerId: string

  @ApiProperty({ format: 'uuid' })
  @Column('uuid')
  eventId: string

  @ApiProperty({ type: String, format: 'date-time' })
  @Column('timestamptz')
  sampledAt: Date

  @ApiProperty()
  @Column('double precision')
  runnerMemoryPercent: number

  @ApiProperty({ type: [BoxMemoryUsageDto], maxItems: 5 })
  @Column('jsonb')
  boxes: BoxMemoryUsageDto[]

  @ApiProperty()
  @Column('boolean')
  samplingComplete: boolean

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date
}

export class MemoryIncidentListDto {
  @ApiProperty({ type: [RunnerMemoryIncident] })
  items: RunnerMemoryIncident[]
}
