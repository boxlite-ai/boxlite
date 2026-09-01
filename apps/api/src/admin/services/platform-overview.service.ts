import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { Job } from '../../box/entities/job.entity'
import { Runner } from '../../box/entities/runner.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { JobStatus } from '../../box/enums/job-status.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { Region } from '../../region/entities/region.entity'
import { cursorValue, pageOf, uuidCursorValue } from '../utils/pagination'

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
type RegionRunner = Pick<Runner, 'id' | 'region' | 'state' | 'draining' | 'cpu' | 'memoryGiB' | 'updatedAt'>
type RegionBox = Pick<Box, 'id' | 'region' | 'state' | 'desiredState' | 'updatedAt'>

const GIB = 1024 * 1024 * 1024
const inactiveBoxStates = [BoxState.DESTROYED, BoxState.ARCHIVED]
const timestamp = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)
const latestDate = (dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((latest, value) => (!value || (latest && latest >= value) ? latest : value), null)
const groupBy = <T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> => {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = grouped.get(key)
    if (group) group.push(item)
    else grouped.set(key, [item])
  }
  return grouped
}
const healthForBox = (state: string, desiredState: string): 'critical' | 'degraded' | 'healthy' | 'unknown' => {
  if (state === BoxState.ERROR) return 'critical'
  if (state !== desiredState) return 'degraded'
  if (state === BoxState.UNKNOWN) return 'unknown'
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
    const context = await this.regionContext(page.items.map((region) => region.id))

    return {
      ...page,
      items: page.items.map((region) => this.regionSummary(region, context)),
    }
  }

  async region(id: string) {
    const region = await this.regionRepository.findOne({
      where: { id },
      select: { id: true, name: true, regionType: true, updatedAt: true },
    })
    if (!region) return null

    return this.regionSummary(region, await this.regionContext([id]))
  }

  private async regionContext(regionIds: string[]) {
    if (regionIds.length === 0) {
      return {
        runnersByRegion: new Map<string, RegionRunner[]>(),
        boxesByRegion: new Map<string, RegionBox[]>(),
        pendingJobsByRegion: new Map<string, number>(),
      }
    }

    const [runners, boxes] = await Promise.all([
      this.runnerRepository.find({
        where: { region: In(regionIds) },
        select: {
          id: true,
          region: true,
          state: true,
          draining: true,
          cpu: true,
          memoryGiB: true,
          updatedAt: true,
        },
      }),
      this.boxRepository.find({
        where: { region: In(regionIds) },
        select: { id: true, region: true, state: true, desiredState: true, updatedAt: true },
      }),
    ])
    const runnerIds = runners.map((runner) => runner.id)
    const pendingJobs =
      runnerIds.length === 0
        ? []
        : await this.jobRepository.find({
            where: { runnerId: In(runnerIds), status: JobStatus.PENDING },
            select: { id: true, runnerId: true },
          })
    const runnerRegions = new Map(runners.map((runner) => [runner.id, runner.region]))
    const pendingJobsByRegion = new Map<string, number>()
    for (const job of pendingJobs) {
      const regionId = runnerRegions.get(job.runnerId)
      if (regionId) pendingJobsByRegion.set(regionId, (pendingJobsByRegion.get(regionId) ?? 0) + 1)
    }
    return {
      runnersByRegion: groupBy(runners, (runner) => runner.region),
      boxesByRegion: groupBy(boxes, (box) => box.region),
      pendingJobsByRegion,
    }
  }

  private regionSummary(region: Region, context: Awaited<ReturnType<AdminPlatformOverviewService['regionContext']>>) {
    const allRunners = context.runnersByRegion.get(region.id) ?? []
    const activeRunners = allRunners.filter((runner) => runner.state !== RunnerState.DECOMMISSIONED)
    const allBoxes = context.boxesByRegion.get(region.id) ?? []
    const activeBoxes = allBoxes.filter((box) => !inactiveBoxStates.includes(box.state))
    const unresponsiveRunnerCount = activeRunners.filter((runner) => runner.state === RunnerState.UNRESPONSIVE).length
    const nonReadyRunnerCount = activeRunners.filter((runner) => runner.state !== RunnerState.READY).length
    const drainingRunnerCount = activeRunners.filter((runner) => runner.draining).length
    const criticalBoxCount = activeBoxes.filter((box) => box.state === BoxState.ERROR).length
    const degradedBoxCount = activeBoxes.filter(
      (box) => box.state !== BoxState.ERROR && String(box.state) !== String(box.desiredState),
    ).length
    const state: RegionState =
      unresponsiveRunnerCount > 0 || criticalBoxCount > 0
        ? 'critical'
        : nonReadyRunnerCount > 0 || drainingRunnerCount > 0 || degradedBoxCount > 0
          ? 'degraded'
          : activeRunners.length === 0
            ? activeBoxes.length === 0
              ? 'unknown'
              : 'degraded'
            : 'healthy'

    return {
      id: region.id,
      name: region.name,
      type: region.regionType,
      state,
      runnerCount: activeRunners.length,
      boxCount: activeBoxes.length,
      queueDepth: context.pendingJobsByRegion.get(region.id) ?? 0,
      cpuCapacityMillis: activeRunners.reduce((total, runner) => total + runner.cpu * 1000, 0),
      memoryCapacityBytes: String(
        Math.round(activeRunners.reduce((total, runner) => total + runner.memoryGiB * GIB, 0)),
      ),
      observedAt: timestamp(
        latestDate([
          region.updatedAt,
          ...allRunners.map((runner) => runner.updatedAt),
          ...allBoxes.map((box) => box.updatedAt),
        ]),
      ),
    }
  }

  async boxes(input: ListInput) {
    const after = cursorValue(input.cursor)
    const boxes = await this.boxRepository.find({
      where: {
        state: Not(In(inactiveBoxStates)),
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

  async box(id: string) {
    const box = await this.boxRepository.findOne({
      where: { id, state: Not(In(inactiveBoxStates)) },
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

    const [activeJobCounts, jobs] = await Promise.all([
      this.activeJobCounts([id]),
      this.jobRepository.find({
        where: { resourceId: id, resourceType: ResourceType.BOX },
        select: { id: true, type: true },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 200,
      }),
    ])
    return {
      ...this.boxSummary(box, activeJobCounts.get(id) ?? 0),
      jobs: jobs.map((job) => ({ id: job.id, type: job.type })),
    }
  }

  private async activeJobCounts(boxIds: string[]) {
    const counts = new Map<string, number>()
    if (boxIds.length === 0) return counts

    const jobs = await this.jobRepository.find({
      where: { resourceId: In(boxIds), resourceType: ResourceType.BOX, completedAt: IsNull() },
      select: { resourceId: true },
    })
    for (const job of jobs) counts.set(job.resourceId, (counts.get(job.resourceId) ?? 0) + 1)
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
      observedAt: timestamp(box.updatedAt),
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
      createdAt: timestamp(job.createdAt),
      startedAt: timestamp(job.startedAt),
      finishedAt: timestamp(job.completedAt),
      durationMs: job.startedAt && job.completedAt ? job.completedAt.getTime() - job.startedAt.getTime() : null,
      errorCategory,
      observedAt: timestamp(job.updatedAt),
    }
  }

  async componentIdentities() {
    const runners = await this.runnerRepository.find({
      where: { state: Not(RunnerState.DECOMMISSIONED) },
      select: { appVersion: true },
      order: { appVersion: 'ASC' },
    })
    const counts = new Map<string | null, number>()
    for (const runner of runners) counts.set(runner.appVersion, (counts.get(runner.appVersion) ?? 0) + 1)
    return {
      api: { version: process.env.BOXLITE_API_VERSION?.trim() || null },
      runners: [...counts].map(([version, count]) => ({ version, count })),
      observedAt: new Date().toISOString(),
    }
  }
}
