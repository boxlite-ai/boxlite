import { BadRequestException, Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
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
    const filtered = this.db
      .getRepository(RunnerMemoryIncident)
      .createQueryBuilder('incident')
      .select('incident.*')
      .where('incident."sampledAt" >= :from AND incident."sampledAt" < :to', { from, to })
    if (query.runnerId) filtered.andWhere('incident."runnerId" = :runnerId', { runnerId: query.runnerId })

    // Rank entries across the full range before rebuilding snapshots and applying the row limit.
    const items = await this.db
      .createQueryBuilder()
      .addCommonTableExpression(filtered, 'filtered')
      .addCommonTableExpression(
        `SELECT incident.id, entry.box, entry.ordinality,
                ROW_NUMBER() OVER (
                  PARTITION BY entry.box->>'boxId'
                  ORDER BY (entry.box->>'memoryBytes')::bigint DESC, incident.id ASC
                ) AS position
         FROM filtered incident
         CROSS JOIN LATERAL jsonb_array_elements(incident.boxes) WITH ORDINALITY AS entry(box, ordinality)`,
        'ranked',
      )
      .addCommonTableExpression(
        `SELECT id, jsonb_agg(box ORDER BY ordinality) AS boxes
         FROM ranked WHERE position = 1 GROUP BY id`,
        'winners',
      )
      .select([
        'incident.id',
        'incident."runnerId"',
        'incident."eventId"',
        'incident."sampledAt"',
        'incident."runnerMemoryPercent"',
        'incident."samplingComplete"',
        'incident."receivedAt"',
      ])
      .addSelect("COALESCE(winners.boxes, '[]'::jsonb)", 'boxes')
      .from('filtered', 'incident')
      .leftJoin('winners', 'winners', 'winners.id = incident.id')
      .where("winners.id IS NOT NULL OR incident.boxes = '[]'::jsonb")
      .orderBy('incident."id"', 'ASC')
      .limit(query.limit)
      .getRawMany<RunnerMemoryIncident>()
    return { items }
  }
}
