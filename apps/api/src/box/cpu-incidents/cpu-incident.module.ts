import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AdminRunnerCpuIncidentController, RunnerCpuIncidentController } from './cpu-incident.controller'
import { RunnerCpuIncident } from './cpu-incident.entity'
import { CpuIncidentService } from './cpu-incident.service'

@Module({
  imports: [TypeOrmModule.forFeature([RunnerCpuIncident])],
  controllers: [AdminRunnerCpuIncidentController, RunnerCpuIncidentController],
  providers: [CpuIncidentService],
})
export class CpuIncidentModule {}
