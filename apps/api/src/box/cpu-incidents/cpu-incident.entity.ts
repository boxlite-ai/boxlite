import { ApiProperty } from '@nestjs/swagger'
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm'

@Entity('runner_cpu_incident')
@Unique('runner_cpu_incident_event_unique', ['runnerId', 'eventId'])
@Index('runner_cpu_incident_runner_id_idx', ['runnerId', 'id'])
@Index('runner_cpu_incident_window_ended_at_idx', ['windowEndedAt'])
export class RunnerCpuIncident {
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
  highCpuSince: Date

  @ApiProperty({ type: String, format: 'date-time' })
  @Column('timestamptz')
  windowStartedAt: Date

  @ApiProperty({ type: String, format: 'date-time' })
  @Column('timestamptz')
  windowEndedAt: Date

  @ApiProperty({ description: 'Host-wide percent at trigger.' })
  @Column('double precision')
  runnerCpuPercent: number

  @ApiProperty({ type: String, nullable: true })
  @Column({ type: 'varchar', length: 128, nullable: true })
  boxId: string | null

  @ApiProperty({ type: String, nullable: true, description: 'Winning box Image string at capture time.' })
  @Column({ type: 'text', nullable: true })
  image: string | null

  @ApiProperty({ description: 'Measured cumulative CPU-seconds across all cores.' })
  @Column('double precision')
  cpuSeconds: number

  @ApiProperty()
  @Column('boolean')
  samplingComplete: boolean

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date
}

export class CpuIncidentListDto {
  @ApiProperty({ type: [RunnerCpuIncident] })
  items: RunnerCpuIncident[]
}
