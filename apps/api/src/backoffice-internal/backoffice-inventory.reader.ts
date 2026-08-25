/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { FindOptionsSelect, FindOptionsWhere, In, MoreThan, Not, Repository } from 'typeorm'
import { Box } from '../box/entities/box.entity'
import { Job } from '../box/entities/job.entity'
import { Runner } from '../box/entities/runner.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { JobStatus } from '../box/enums/job-status.enum'
import { ResourceType } from '../box/enums/resource-type.enum'
import { BOX_ID_REGEX } from '../box/utils/box-id.util'
import { Region } from '../region/entities/region.entity'
import {
  BACKOFFICE_INVENTORY_DEFAULT_LIMIT,
  BackofficeBoxesQueryDto,
  BackofficeRunnersQueryDto,
} from './backoffice-inventory.dto'
import {
  BackofficeBoxSummary,
  BackofficeRunnerCounts,
  BackofficeRunnerSummary,
  toBackofficeBoxSummary,
  toBackofficeRunnerSummary,
} from './backoffice-inventory.mapper'

const ACTIVE_JOB_STATUSES = [JobStatus.PENDING, JobStatus.IN_PROGRESS]
const INACTIVE_BOX_STATES = [BoxState.DESTROYED, BoxState.ARCHIVED]
const DETAIL_REFERENCE_LIMIT = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const BOX_SELECT: FindOptionsSelect<Box> = {
  id: true,
  organizationId: true,
  name: true,
  region: true,
  runnerId: true,
  desiredState: true,
  state: true,
  cpu: true,
  mem: true,
  disk: true,
  createdAt: true,
  updatedAt: true,
}

const RUNNER_SELECT: FindOptionsSelect<Runner> = {
  id: true,
  name: true,
  region: true,
  state: true,
  unschedulable: true,
  draining: true,
  apiVersion: true,
  appVersion: true,
  cpu: true,
  memoryGiB: true,
  diskGiB: true,
  currentAllocatedCpu: true,
  currentAllocatedMemoryGiB: true,
  currentAllocatedDiskGiB: true,
  currentCpuUsagePercentage: true,
  currentMemoryUsagePercentage: true,
  currentDiskUsagePercentage: true,
  currentStartedBoxes: true,
  availabilityScore: true,
  lastChecked: true,
  createdAt: true,
  updatedAt: true,
}

type InventoryResource = 'boxes' | 'runners'

interface InventoryCursor {
  v: 1
  resource: InventoryResource
  id: string
}

interface CountRow {
  id: string
  status?: JobStatus
  count: string
}

export interface BackofficeInventoryPage<T> {
  items: T[]
  nextCursor: string | null
  limit: number
  observedAt: string
}

export interface BackofficeBoxDetail extends BackofficeBoxSummary {
  activeJobIds: string[]
  activeJobIdsTruncated: boolean
}

export interface BackofficeRunnerDetail extends BackofficeRunnerSummary {
  boxIds: string[]
  boxIdsTruncated: boolean
  activeJobIds: string[]
  activeJobIdsTruncated: boolean
}

function encodeCursor(resource: InventoryResource, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, resource, id } satisfies InventoryCursor)).toString('base64url')
}

function decodeCursor(resource: InventoryResource, cursor?: string): string | undefined {
  if (!cursor) return undefined

  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<InventoryCursor>
    const validId =
      resource === 'boxes'
        ? typeof value.id === 'string' && BOX_ID_REGEX.test(value.id)
        : typeof value.id === 'string' && UUID.test(value.id)
    if (value.v !== 1 || value.resource !== resource || !validId) throw new Error('invalid cursor')
    return value.id
  } catch {
    throw new BadRequestException('Invalid pagination cursor')
  }
}

function countById(rows: CountRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + Number(row.count))
  return counts
}

function boundedIds<T extends { id: string }>(items: T[]): { ids: string[]; truncated: boolean } {
  return {
    ids: items.slice(0, DETAIL_REFERENCE_LIMIT).map((item) => item.id),
    truncated: items.length > DETAIL_REFERENCE_LIMIT,
  }
}

@Injectable()
export class BackofficeInventoryReader {
  constructor(
    @InjectRepository(Box) private readonly boxRepository: Repository<Box>,
    @InjectRepository(Runner) private readonly runnerRepository: Repository<Runner>,
    @InjectRepository(Job) private readonly jobRepository: Repository<Job>,
    @InjectRepository(Region) private readonly regionRepository: Repository<Region>,
  ) {}

  async boxes(query: BackofficeBoxesQueryDto): Promise<BackofficeInventoryPage<BackofficeBoxSummary>> {
    const limit = query.limit ?? BACKOFFICE_INVENTORY_DEFAULT_LIMIT
    const cursorId = decodeCursor('boxes', query.cursor)
    const where: FindOptionsWhere<Box> = {}
    if (cursorId) where.id = MoreThan(cursorId)
    if (query.organizationId) where.organizationId = query.organizationId
    if (query.regionId) where.region = query.regionId
    if (query.runnerId) where.runnerId = query.runnerId
    if (query.state) where.state = query.state

    const rows = await this.boxRepository.find({ select: BOX_SELECT, where, order: { id: 'ASC' }, take: limit + 1 })
    const pageRows = rows.slice(0, limit)
    const activeJobCounts = await this.boxActiveJobCounts(pageRows.map((box) => box.id))

    return {
      items: pageRows.map((box) => toBackofficeBoxSummary(box, activeJobCounts.get(box.id) ?? 0)),
      nextCursor: rows.length > limit ? encodeCursor('boxes', pageRows[pageRows.length - 1].id) : null,
      limit,
      observedAt: new Date().toISOString(),
    }
  }

  async box(id: string): Promise<BackofficeBoxDetail> {
    if (!BOX_ID_REGEX.test(id)) throw new BadRequestException('Invalid Box ID')
    const box = await this.boxRepository.findOne({ select: BOX_SELECT, where: { id } })
    if (!box) throw new NotFoundException('Box not found')

    const [activeJobCounts, activeJobs] = await Promise.all([
      this.boxActiveJobCounts([id]),
      this.jobRepository.find({
        select: { id: true },
        where: { resourceType: ResourceType.BOX, resourceId: id, status: In(ACTIVE_JOB_STATUSES) },
        order: { id: 'ASC' },
        take: DETAIL_REFERENCE_LIMIT + 1,
      }),
    ])
    const references = boundedIds(activeJobs)
    return {
      ...toBackofficeBoxSummary(box, activeJobCounts.get(id) ?? 0),
      activeJobIds: references.ids,
      activeJobIdsTruncated: references.truncated,
    }
  }

  async runners(query: BackofficeRunnersQueryDto): Promise<BackofficeInventoryPage<BackofficeRunnerSummary>> {
    const limit = query.limit ?? BACKOFFICE_INVENTORY_DEFAULT_LIMIT
    const cursorId = decodeCursor('runners', query.cursor)
    const where: FindOptionsWhere<Runner> = {}
    if (cursorId) where.id = MoreThan(cursorId)
    if (query.regionId) where.region = query.regionId
    if (query.state) where.state = query.state

    if (query.organizationId) {
      const regions = await this.regionRepository.find({
        select: { id: true },
        where: { organizationId: query.organizationId },
      })
      const regionIds = regions.map((region) => region.id)
      if (query.regionId) {
        if (!regionIds.includes(query.regionId)) return this.emptyPage(limit)
      } else {
        if (regionIds.length === 0) return this.emptyPage(limit)
        where.region = In(regionIds)
      }
    }

    const rows = await this.runnerRepository.find({
      select: RUNNER_SELECT,
      where,
      order: { id: 'ASC' },
      take: limit + 1,
    })
    const pageRows = rows.slice(0, limit)
    const counts = await this.runnerCounts(pageRows.map((runner) => runner.id))

    return {
      items: pageRows.map((runner) => toBackofficeRunnerSummary(runner, counts.get(runner.id) ?? this.zeroCounts())),
      nextCursor: rows.length > limit ? encodeCursor('runners', pageRows[pageRows.length - 1].id) : null,
      limit,
      observedAt: new Date().toISOString(),
    }
  }

  async runner(id: string): Promise<BackofficeRunnerDetail> {
    if (!UUID.test(id)) throw new BadRequestException('Invalid Runner ID')
    const runner = await this.runnerRepository.findOne({ select: RUNNER_SELECT, where: { id } })
    if (!runner) throw new NotFoundException('Runner not found')

    const [counts, boxes, activeJobs] = await Promise.all([
      this.runnerCounts([id]),
      this.boxRepository.find({
        select: { id: true },
        where: { runnerId: id, state: Not(In(INACTIVE_BOX_STATES)) },
        order: { id: 'ASC' },
        take: DETAIL_REFERENCE_LIMIT + 1,
      }),
      this.jobRepository.find({
        select: { id: true },
        where: { runnerId: id, status: In(ACTIVE_JOB_STATUSES) },
        order: { id: 'ASC' },
        take: DETAIL_REFERENCE_LIMIT + 1,
      }),
    ])
    const boxReferences = boundedIds(boxes)
    const jobReferences = boundedIds(activeJobs)
    return {
      ...toBackofficeRunnerSummary(runner, counts.get(id) ?? this.zeroCounts()),
      boxIds: boxReferences.ids,
      boxIdsTruncated: boxReferences.truncated,
      activeJobIds: jobReferences.ids,
      activeJobIdsTruncated: jobReferences.truncated,
    }
  }

  private async boxActiveJobCounts(boxIds: string[]): Promise<Map<string, number>> {
    if (boxIds.length === 0) return new Map()
    const rows = await this.jobRepository
      .createQueryBuilder('boxJob')
      .select('boxJob.resourceId', 'id')
      .addSelect('boxJob.status', 'status')
      .addSelect('COUNT(boxJob.id)', 'count')
      .where('boxJob.resourceType = :resourceType', { resourceType: ResourceType.BOX })
      .andWhere('boxJob.resourceId IN (:...boxIds)', { boxIds })
      .andWhere('boxJob.status IN (:...statuses)', { statuses: ACTIVE_JOB_STATUSES })
      .groupBy('boxJob.resourceId')
      .addGroupBy('boxJob.status')
      .getRawMany<CountRow>()
    return countById(rows)
  }

  private async runnerCounts(runnerIds: string[]): Promise<Map<string, BackofficeRunnerCounts>> {
    if (runnerIds.length === 0) return new Map()
    const [boxRows, jobRows] = await Promise.all([
      this.boxRepository
        .createQueryBuilder('box')
        .select('box.runnerId', 'id')
        .addSelect('COUNT(box.id)', 'count')
        .where('box.runnerId IN (:...runnerIds)', { runnerIds })
        .andWhere('box.state NOT IN (:...inactiveStates)', { inactiveStates: INACTIVE_BOX_STATES })
        .groupBy('box.runnerId')
        .getRawMany<CountRow>(),
      this.jobRepository
        .createQueryBuilder('runnerJob')
        .select('runnerJob.runnerId', 'id')
        .addSelect('runnerJob.status', 'status')
        .addSelect('COUNT(runnerJob.id)', 'count')
        .where('runnerJob.runnerId IN (:...runnerIds)', { runnerIds })
        .andWhere('runnerJob.status IN (:...statuses)', { statuses: ACTIVE_JOB_STATUSES })
        .groupBy('runnerJob.runnerId')
        .addGroupBy('runnerJob.status')
        .getRawMany<CountRow>(),
    ])
    const counts = new Map<string, BackofficeRunnerCounts>()
    for (const runnerId of runnerIds) counts.set(runnerId, this.zeroCounts())
    for (const row of boxRows) {
      const runnerCounts = counts.get(row.id)
      if (runnerCounts) runnerCounts.boxCount = Number(row.count)
    }
    for (const row of jobRows) {
      const runnerCounts = counts.get(row.id)
      if (!runnerCounts) continue
      const count = Number(row.count)
      runnerCounts.activeJobCount += count
      if (row.status === JobStatus.PENDING) runnerCounts.queueDepth += count
    }
    return counts
  }

  private emptyPage<T>(limit: number): BackofficeInventoryPage<T> {
    return { items: [], nextCursor: null, limit, observedAt: new Date().toISOString() }
  }

  private zeroCounts(): BackofficeRunnerCounts {
    return { boxCount: 0, activeJobCount: 0, queueDepth: 0 }
  }
}
