import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AdminRunnerMemoryIncidentController, RunnerMemoryIncidentController } from './memory-incident.controller'
import { RunnerMemoryIncident } from './memory-incident.entity'
import { MemoryIncidentService } from './memory-incident.service'

@Module({
  imports: [TypeOrmModule.forFeature([RunnerMemoryIncident])],
  controllers: [AdminRunnerMemoryIncidentController, RunnerMemoryIncidentController],
  providers: [MemoryIncidentService],
})
export class MemoryIncidentModule {}
