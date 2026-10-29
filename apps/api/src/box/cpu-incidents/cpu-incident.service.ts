import { BadRequestException, Injectable } from '@nestjs/common'
import { And, DataSource, LessThan, MoreThanOrEqual } from 'typeorm'
import { ListCpuIncidentsDto, RunnerCpuIncidentDto } from './cpu-incident.dto'
import { CpuIncidentListDto, RunnerCpuIncident } from './cpu-incident.entity'

@Injectable()
export class CpuIncidentService {
  constructor(private readonly db: DataSource) {}

  async record(runnerId: string, report: RunnerCpuIncidentDto): Promise<void> {
    const highCpuSince = new Date(report.highCpuSince)
    const windowStartedAt = new Date(report.windowStartedAt)
    const windowEndedAt = new Date(report.windowEndedAt)
    const pendingMs = windowStartedAt.getTime() - highCpuSince.getTime()
    const captureMs = windowEndedAt.getTime() - windowStartedAt.getTime()
    if (
      !Number.isFinite(pendingMs) ||
      !Number.isFinite(captureMs) ||
      pendingMs < 300_000 ||
      captureMs < 120_000 ||
      captureMs > 300_000 ||
      report.runnerCpuPercent <= 80 ||
      (report.boxId === null && report.image != null) ||
      (report.boxId === null ? report.cpuSeconds !== 0 : report.cpuSeconds <= 0)
    )
      throw new BadRequestException('Invalid CPU incident window or attribution')

    await this.db
      .createQueryBuilder()
      .insert()
      .into(RunnerCpuIncident)
      .values({
        runnerId,
        eventId: report.eventId,
        highCpuSince,
        windowStartedAt,
        windowEndedAt,
        runnerCpuPercent: report.runnerCpuPercent,
        boxId: report.boxId,
        image: report.image ?? null,
        cpuSeconds: report.cpuSeconds,
        samplingComplete: report.samplingComplete,
      })
      .onConflict('("runnerId", "eventId") DO NOTHING')
      .execute()
  }

  async list(query: ListCpuIncidentsDto): Promise<CpuIncidentListDto> {
    const from = new Date(query.from)
    const to = new Date(query.to)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to)
      throw new BadRequestException('Invalid CPU incident time range: from must precede to')
    const items = await this.db.getRepository(RunnerCpuIncident).find({
      where: {
        windowEndedAt: And(MoreThanOrEqual(from), LessThan(to)),
        ...(query.runnerId ? { runnerId: query.runnerId } : {}),
      },
      order: { id: 'ASC' },
      take: query.limit,
    })
    return { items }
  }
}
