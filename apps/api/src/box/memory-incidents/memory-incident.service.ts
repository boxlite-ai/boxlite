import { BadRequestException, Injectable } from '@nestjs/common'
import { And, DataSource, LessThan, MoreThanOrEqual } from 'typeorm'
import { ListMemoryIncidentsDto, RunnerMemoryIncidentDto } from './memory-incident.dto'
import { MemoryIncidentListDto, RunnerMemoryIncident } from './memory-incident.entity'

@Injectable()
export class MemoryIncidentService {
  constructor(private readonly db: DataSource) {}

  async record(runnerId: string, report: RunnerMemoryIncidentDto): Promise<void> {
    const sampledAt = new Date(report.sampledAt)
    if (
      !Number.isFinite(sampledAt.getTime()) ||
      !Number.isFinite(report.runnerMemoryPercent) ||
      report.runnerMemoryPercent <= 80 ||
      report.runnerMemoryPercent > 100
    )
      throw new BadRequestException('Invalid memory incident sample')

    // DTO validation owns the shape; compare byte strings with BigInt to keep exact ordering.
    for (let i = 0; i < report.boxes.length; i++) {
      const box = report.boxes[i]
      const bytes = BigInt(box.memoryBytes)
      const previous = report.boxes[i - 1]
      if (
        bytes > 9223372036854775807n ||
        (previous &&
          (bytes > BigInt(previous.memoryBytes) ||
            (bytes === BigInt(previous.memoryBytes) && box.boxId <= previous.boxId)))
      )
        throw new BadRequestException('Invalid memory incident byte range or ranking')
    }
    await this.db
      .createQueryBuilder()
      .insert()
      .into(RunnerMemoryIncident)
      .values({
        runnerId,
        eventId: report.eventId,
        sampledAt,
        runnerMemoryPercent: report.runnerMemoryPercent,
        boxes: report.boxes,
        samplingComplete: report.samplingComplete,
      })
      .onConflict('("runnerId", "eventId") DO NOTHING')
      .execute()
  }

  async list(query: ListMemoryIncidentsDto): Promise<MemoryIncidentListDto> {
    const from = new Date(query.from)
    const to = new Date(query.to)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to)
      throw new BadRequestException('Invalid memory incident time range: from must precede to')
    const items = await this.db.getRepository(RunnerMemoryIncident).find({
      where: {
        sampledAt: And(MoreThanOrEqual(from), LessThan(to)),
        ...(query.runnerId ? { runnerId: query.runnerId } : {}),
      },
      order: { id: 'ASC' },
      take: query.limit,
    })
    return { items }
  }
}
