import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, MoreThan, Not, Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { Job } from '../../box/entities/job.entity'
import { Runner } from '../../box/entities/runner.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { JobStatus } from '../../box/enums/job-status.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { Region } from '../../region/entities/region.entity'
import { cursorValue, pageOf, timeCursorKey, timeCursorValue, uuidCursorValue } from '../utils/pagination'
import { GIB, INACTIVE_BOX_STATES, isoTimestamp, latestDate } from '../utils/projection'

type ListInput = { cursor?: string; limit: number }
type RegionState = 'critical' | 'degraded' | 'healthy' | 'unknown'
type BoxSummary = Pick<
  Box,
  | 'id'
  | 'name'
  | 'organizationId'
  | 'runnerId'
  | 'region'
  | 'desiredState'
  | 'state'
  | 'cpu'
  | 'mem'
  | 'disk'
  | 'updatedAt'
>
type JobSummary = Pick<
  Job,
  | 'id'
  | 'type'
  | 'status'
  | 'runnerId'
  | 'resourceType'
  | 'resourceId'
  | 'createdAt'
  | 'startedAt'
  | 'completedAt'
  | 'errorMessage'
  | 'updatedAt'
>
type BoxListInput = ListInput
type BoxDetailInput = { jobCursor?: string; jobLimit: number }
// One row per (region, state, ...) combination rather than one row per entity: the
// result set is bounded by the enum cross-product, not by how many rows the fleet holds.
type RunnerGroupRow = {
  region: string
  state: RunnerState
  draining: boolean
  runnerCount: string
  cpuTotal: string | number | null
  memoryTotal: string | number | null
  observedAt: Date | null
}
type BoxGroupRow = {
  region: string
  state: BoxState
  desiredState: string
  boxCount: string
  observedAt: Date | null
}
type QueueDepthRow = { region: string; queueDepth: string }
type RegionStats = {
  runnerCount: number
  readyRunnerCount: number
  drainingRunnerCount: number
  unresponsiveRunnerCount: number
  cpuCapacityMillis: number
  memoryCapacityBytes: number
  boxCount: number
  criticalBoxCount: number
  degradedBoxCount: number
  queueDepth: number
  observedAt: Date | null
}

const count = (value: string | number | null | undefined): number => Number(value ?? 0) || 0
const emptyStats = (): RegionStats => ({
  runnerCount: 0,
  readyRunnerCount: 0,
  drainingRunnerCount: 0,
  unresponsiveRunnerCount: 0,
  cpuCapacityMillis: 0,
  memoryCapacityBytes: 0,
  boxCount: 0,
  criticalBoxCount: 0,
  degradedBoxCount: 0,
  queueDepth: 0,
  observedAt: null,
})
// UNKNOWN is checked before the mismatch: BoxDesiredState has no UNKNOWN member, so a box
// whose observed state is unknown can never equal its desired state, and testing the
// mismatch first would report every one of them as degraded and leave 'unknown' unreachable.
const healthForBox = (state: string, desiredState: string): 'critical' | 'degraded' | 'healthy' | 'unknown' => {
  if (state === BoxState.ERROR) return 'critical'
  if (state === BoxState.UNKNOWN) return 'unknown'
  if (state !== desiredState) return 'degraded'
  return 'healthy'
}

@Injectable()
export class AdminPlatformOverviewService {
  constructor(
    @InjectRepository(Region) private readonly regionRepository: Repository<Region>,
    @InjectRepository(Runner) private readonly runnerRepository: Repository<Runner>,
    @InjectRepository(Box) private readonly boxRepository: Repository<Box>,
    @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
  ) {}

  async regions(input: ListInput) {
    const after = cursorValue(input.cursor)
    const regions = await this.regionRepository.find({
      where: after ? { id: MoreThan(after) } : {},
      select: { id: true, name: true, regionType: true, updatedAt: true },
      order: { id: 'ASC' },
      take: input.limit + 1,
    })
    const page = pageOf(regions, input.limit, (region) => region.id)
    const stats = await this.regionStats(page.items.map((region) => region.id))

    return {
      ...page,
      items: page.items.map((region) => this.regionSummary(region, stats.get(region.id) ?? emptyStats())),
    }
  }

  async region(id: string) {
    const region = await this.regionRepository.findOne({
      where: { id },
      select: { id: true, name: true, regionType: true, updatedAt: true },
    })
    if (!region) return null

    return this.regionSummary(region, (await this.regionStats([id])).get(id) ?? emptyStats())
  }

  /**
   * Counts a region's fleet in the database. The page above is bounded, so the work
   * behind it must be too: grouping by the state enums keeps every result set sized by
   * the enum cross-product instead of by how many runners, boxes, or jobs exist.
   */
  private async regionStats(regionIds: string[]): Promise<Map<string, RegionStats>> {
    const stats = new Map<string, RegionStats>()
    if (regionIds.length === 0) return stats

    const [runnerGroups, boxGroups, queueDepths] = await Promise.all([
      this.runnerRepository
        .createQueryBuilder('runner')
        .select('runner.region', 'region')
        .addSelect('runner.state', 'state')
        .addSelect('runner.draining', 'draining')
        .addSelect('COUNT(*)', 'runnerCount')
        .addSelect('SUM(runner.cpu)', 'cpuTotal')
        .addSelect('SUM(runner."memoryGiB")', 'memoryTotal')
        .addSelect('MAX(runner."updatedAt")', 'observedAt')
        .where('runner.region IN (:...regionIds)', { regionIds })
        .groupBy('runner.region')
        .addGroupBy('runner.state')
        .addGroupBy('runner.draining')
        .getRawMany<RunnerGroupRow>(),
      this.boxRepository
        .createQueryBuilder('box')
        .select('box.region', 'region')
        .addSelect('box.state', 'state')
        .addSelect('box."desiredState"', 'desiredState')
        .addSelect('COUNT(*)', 'boxCount')
        .addSelect('MAX(box."updatedAt")', 'observedAt')
        .where('box.region IN (:...regionIds)', { regionIds })
        .groupBy('box.region')
        .addGroupBy('box.state')
        .addGroupBy('box."desiredState"')
        .getRawMany<BoxGroupRow>(),
      this.jobRepository
        .createQueryBuilder('job')
        // job."runnerId" is character varying while runner.id is uuid, and Postgres has no
        // implicit cast between them. The cast goes on the uuid side because casting the
        // job side would fail the whole query on any single row that does not parse as a
        // uuid, where a uuid always renders as text. This is the only runner-to-job join in
        // the codebase; usage.service.ts casts a uuid to text the same way, but in a WHERE
        // comparison rather than a join.
        .innerJoin(Runner, 'runner', 'runner.id::text = job."runnerId"')
        .select('runner.region', 'region')
        .addSelect('COUNT(*)', 'queueDepth')
        .where('runner.region IN (:...regionIds)', { regionIds })
        .andWhere('job.status = :pending', { pending: JobStatus.PENDING })
        .groupBy('runner.region')
        .getRawMany<QueueDepthRow>(),
    ])

    const statsFor = (regionId: string): RegionStats => {
      const existing = stats.get(regionId)
      if (existing) return existing
      const created = emptyStats()
      stats.set(regionId, created)
      return created
    }
    for (const group of runnerGroups) {
      const region = statsFor(group.region)
      region.observedAt = latestDate([region.observedAt, group.observedAt])
      if (group.state === RunnerState.DECOMMISSIONED) continue
      const runners = count(group.runnerCount)
      region.runnerCount += runners
      region.cpuCapacityMillis += count(group.cpuTotal) * 1000
      region.memoryCapacityBytes += count(group.memoryTotal) * GIB
      if (group.draining) region.drainingRunnerCount += runners
      if (group.state === RunnerState.READY) region.readyRunnerCount += runners
      if (group.state === RunnerState.UNRESPONSIVE) region.unresponsiveRunnerCount += runners
    }
    for (const group of boxGroups) {
      const region = statsFor(group.region)
      region.observedAt = latestDate([region.observedAt, group.observedAt])
      if (INACTIVE_BOX_STATES.includes(group.state)) continue
      const boxes = count(group.boxCount)
      region.boxCount += boxes
      if (group.state === BoxState.ERROR) region.criticalBoxCount += boxes
      else if (String(group.state) !== String(group.desiredState)) region.degradedBoxCount += boxes
    }
    for (const group of queueDepths) statsFor(group.region).queueDepth += count(group.queueDepth)
    return stats
  }

  private regionSummary(region: Region, stats: RegionStats) {
    // INITIALIZING and DISABLED are the only non-READY states left once UNRESPONSIVE has
    // already produced `critical`, and status-sync.service.ts scopes the serving fleet to
    // READY|UNRESPONSIVE precisely because those two are birth state and operator intent.
    // Reporting them as degradation would turn every scale-out amber. The empty-capacity
    // branch still counts READY alone, though: a region whose whole fleet is initializing
    // carries no traffic, and calling that healthy would hide an outage behind this rule.
    const state: RegionState =
      stats.unresponsiveRunnerCount > 0 || stats.criticalBoxCount > 0
        ? 'critical'
        : stats.drainingRunnerCount > 0 || stats.degradedBoxCount > 0
          ? 'degraded'
          : stats.readyRunnerCount === 0
            ? stats.boxCount === 0
              ? 'unknown'
              : 'degraded'
            : 'healthy'

    return {
      id: region.id,
      name: region.name,
      type: region.regionType,
      state,
      runnerCount: stats.runnerCount,
      boxCount: stats.boxCount,
      queueDepth: stats.queueDepth,
      cpuCapacityMillis: stats.cpuCapacityMillis,
      memoryCapacityBytes: String(Math.round(stats.memoryCapacityBytes)),
      observedAt: isoTimestamp(latestDate([region.updatedAt, stats.observedAt])),
    }
  }

  async boxes(input: BoxListInput) {
    const after = cursorValue(input.cursor)
    const boxes = await this.boxRepository.find({
      where: {
        state: Not(In(INACTIVE_BOX_STATES)),
        ...(after ? { id: MoreThan(after) } : {}),
      },
      select: {
        id: true,
        name: true,
        organizationId: true,
        runnerId: true,
        region: true,
        desiredState: true,
        state: true,
        cpu: true,
        mem: true,
        disk: true,
        updatedAt: true,
      },
      order: { id: 'ASC' },
      take: input.limit + 1,
    })
    const page = pageOf(boxes, input.limit, (box) => box.id)
    const activeJobCounts = await this.activeJobCounts(page.items.map((box) => box.id))
    return {
      ...page,
      items: page.items.map((box) => this.boxSummary(box, activeJobCounts.get(box.id) ?? 0)),
    }
  }

  async box(id: string, detail: BoxDetailInput) {
    const jobAfter = timeCursorValue(detail.jobCursor)
    const box = await this.boxRepository.findOne({
      where: { id, state: Not(In(INACTIVE_BOX_STATES)) },
      select: {
        id: true,
        name: true,
        organizationId: true,
        runnerId: true,
        region: true,
        desiredState: true,
        state: true,
        cpu: true,
        mem: true,
        disk: true,
        updatedAt: true,
      },
    })
    if (!box) return null

    // An operator opens a box to see what just happened to it, so the first page has to be
    // what just happened. Job ids are random v4 UUIDs, so ordering by id would make page
    // one an arbitrary sample of the box's whole history, and AdminBoxJobReference carries
    // no timestamp for the caller to re-sort by. The row comparison keeps the keyset seek
    // to one expression over the same pair the ORDER BY uses.
    //
    // Both sort by the millisecond, not by the stored microsecond: job."createdAt" defaults
    // to now() and so carries microseconds, but the cursor is built from the JS Date the
    // driver parsed it into, and a Date holds milliseconds. Seeking a truncated bound into
    // the untruncated column steps over every row sharing the boundary row's millisecond.
    const jobCreatedAt = `date_trunc('milliseconds', job."createdAt")`
    const jobQuery = this.jobRepository
      .createQueryBuilder('job')
      .select(['job.id', 'job.type', 'job.createdAt'])
      .where('job."resourceId" = :id', { id })
      .andWhere('job."resourceType" = :resourceType', { resourceType: ResourceType.BOX })
      .orderBy(jobCreatedAt, 'DESC')
      .addOrderBy('job.id', 'DESC')
      .take(detail.jobLimit + 1)
    if (jobAfter) {
      jobQuery.andWhere(`(${jobCreatedAt}, job.id) < (:jobCreatedAt, :jobId)`, {
        jobCreatedAt: jobAfter.createdAt,
        jobId: jobAfter.id,
      })
    }

    const [activeJobCounts, jobs] = await Promise.all([this.activeJobCounts([id]), jobQuery.getMany()])
    const jobPage = pageOf(jobs, detail.jobLimit, (job) => timeCursorKey(job.createdAt, job.id))
    return {
      ...this.boxSummary(box, activeJobCounts.get(id) ?? 0),
      jobs: { ...jobPage, items: jobPage.items.map((job) => ({ id: job.id, type: job.type })) },
    }
  }

  private async activeJobCounts(boxIds: string[]) {
    const counts = new Map<string, number>()
    if (boxIds.length === 0) return counts

    const groups = await this.jobRepository
      .createQueryBuilder('job')
      .select('job."resourceId"', 'resourceId')
      .addSelect('COUNT(*)', 'activeJobCount')
      .where('job."resourceId" IN (:...boxIds)', { boxIds })
      .andWhere('job."resourceType" = :resourceType', { resourceType: ResourceType.BOX })
      .andWhere('job."completedAt" IS NULL')
      .groupBy('job."resourceId"')
      .getRawMany<{ resourceId: string; activeJobCount: string }>()
    for (const group of groups) counts.set(group.resourceId, count(group.activeJobCount))
    return counts
  }

  private boxSummary(box: BoxSummary, activeJobCount: number) {
    return {
      id: box.id,
      name: box.name,
      organizationId: box.organizationId,
      runnerId: box.runnerId ?? null,
      regionId: box.region,
      desiredState: box.desiredState,
      observedState: box.state,
      health: healthForBox(box.state, box.desiredState),
      cpuMillis: box.cpu * 1000,
      memoryBytes: String(BigInt(box.mem) * BigInt(GIB)),
      storageBytes: String(BigInt(box.disk) * BigInt(GIB)),
      activeJobCount,
      observedAt: isoTimestamp(box.updatedAt),
    }
  }

  async jobs(input: ListInput) {
    const after = uuidCursorValue(input.cursor)
    const jobs = await this.jobRepository.find({
      where: after ? { id: MoreThan(after) } : {},
      select: {
        id: true,
        type: true,
        status: true,
        runnerId: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        errorMessage: true,
        updatedAt: true,
      },
      order: { id: 'ASC' },
      take: input.limit + 1,
    })
    const page = pageOf(jobs, input.limit, (job) => job.id)
    return { ...page, items: page.items.map((job) => this.jobSummary(job)) }
  }

  async job(id: string) {
    const job = await this.jobRepository.findOne({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        runnerId: true,
        resourceType: true,
        resourceId: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        errorMessage: true,
        updatedAt: true,
      },
    })
    return job ? this.jobSummary(job) : null
  }

  private jobSummary(job: JobSummary) {
    const error = (job.errorMessage ?? '').toLowerCase()
    const errorCategory = !error
      ? null
      : error.includes('capacity')
        ? 'capacity'
        : error.includes('network')
          ? 'network'
          : error.includes('image')
            ? 'image'
            : error.includes('storage') || error.includes('disk')
              ? 'storage'
              : error.includes('timeout')
                ? 'timeout'
                : 'unknown'
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      runnerId: job.runnerId ?? null,
      resourceType: job.resourceType,
      resourceId: job.resourceId,
      createdAt: isoTimestamp(job.createdAt),
      startedAt: isoTimestamp(job.startedAt),
      finishedAt: isoTimestamp(job.completedAt),
      durationMs: job.startedAt && job.completedAt ? job.completedAt.getTime() - job.startedAt.getTime() : null,
      errorCategory,
      observedAt: isoTimestamp(job.updatedAt),
    }
  }

  async componentIdentities() {
    const groups = await this.runnerRepository
      .createQueryBuilder('runner')
      .select('runner."appVersion"', 'version')
      .addSelect('COUNT(*)', 'runnerCount')
      .where('runner.state != :decommissioned', { decommissioned: RunnerState.DECOMMISSIONED })
      .groupBy('runner."appVersion"')
      .orderBy('runner."appVersion"', 'ASC')
      .getRawMany<{ version: string | null; runnerCount: string }>()
    return {
      // The Api task is given its release version as VERSION (apps/infra/stack/api.ts);
      // BOXLITE_API_VERSION is the runner's protocol selector and is never set here.
      api: { version: process.env.VERSION?.trim() || null },
      runners: groups.map((group) => ({ version: group.version, count: count(group.runnerCount) })),
      observedAt: new Date().toISOString(),
    }
  }
}
