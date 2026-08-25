/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { Repository } from 'typeorm'
import { Box } from '../box/entities/box.entity'
import { Job } from '../box/entities/job.entity'
import { Runner } from '../box/entities/runner.entity'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { RunnerState } from '../box/enums/runner-state.enum'
import { Region } from '../region/entities/region.entity'
import { BackofficeInventoryReader } from './backoffice-inventory.reader'

const box = (id: string, organizationId = '11111111-1111-4111-8111-111111111111'): Box =>
  ({
    id,
    organizationId,
    name: `box-${id}`,
    region: 'us-east',
    runnerId: '22222222-2222-4222-8222-222222222222',
    desiredState: BoxDesiredState.STARTED,
    state: BoxState.STARTED,
    cpu: 2,
    mem: 4,
    disk: 10,
    createdAt: new Date('2026-08-24T10:00:00.000Z'),
    updatedAt: new Date('2026-08-25T10:00:00.000Z'),
  }) as Box

const runner = (id: string): Runner =>
  ({
    id,
    name: `runner-${id}`,
    region: 'us-east',
    state: RunnerState.READY,
    unschedulable: false,
    draining: false,
    apiVersion: '2',
    appVersion: 'v0.9.7',
    cpu: 8,
    memoryGiB: 16,
    diskGiB: 100,
    currentAllocatedCpu: 2,
    currentAllocatedMemoryGiB: 4,
    currentAllocatedDiskGiB: 10,
    currentCpuUsagePercentage: 20,
    currentMemoryUsagePercentage: 25,
    currentDiskUsagePercentage: 10,
    currentStartedBoxes: 2,
    availabilityScore: 95,
    lastChecked: new Date('2026-08-25T10:00:00.000Z'),
    createdAt: new Date('2026-08-24T10:00:00.000Z'),
    updatedAt: new Date('2026-08-25T10:00:00.000Z'),
  }) as Runner

function aggregateQuery(rows: unknown[] = []) {
  return {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  }
}

function repositories() {
  const boxJobs = aggregateQuery([{ id: 'AbCdEf123456', status: 'PENDING', count: '2' }])
  const runnerBoxes = aggregateQuery([{ id: '22222222-2222-4222-8222-222222222222', count: '3' }])
  const runnerJobs = aggregateQuery([
    { id: '22222222-2222-4222-8222-222222222222', status: 'PENDING', count: '1' },
    { id: '22222222-2222-4222-8222-222222222222', status: 'IN_PROGRESS', count: '2' },
  ])
  const boxRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(runnerBoxes),
  }
  const runnerRepository = { find: jest.fn(), findOne: jest.fn() }
  const jobRepository = {
    find: jest.fn(),
    createQueryBuilder: jest.fn((alias: string) => (alias === 'boxJob' ? boxJobs : runnerJobs)),
  }
  const regionRepository = { find: jest.fn() }
  const reader = new BackofficeInventoryReader(
    boxRepository as unknown as Repository<Box>,
    runnerRepository as unknown as Repository<Runner>,
    jobRepository as unknown as Repository<Job>,
    regionRepository as unknown as Repository<Region>,
  )
  return { reader, boxRepository, runnerRepository, jobRepository, regionRepository }
}

describe('Backoffice internal inventory reader', () => {
  it('uses a stable scoped cursor and selects only allowlisted Box columns', async () => {
    const { reader, boxRepository } = repositories()
    boxRepository.find.mockResolvedValueOnce([box('AbCdEf123456'), box('BcDeFg234567')]).mockResolvedValueOnce([])

    const first = await reader.boxes({ limit: 1, organizationId: '11111111-1111-4111-8111-111111111111' })

    expect(first.items).toHaveLength(1)
    expect(first.items[0]).toMatchObject({ id: 'AbCdEf123456', activeJobCount: 2 })
    expect(first.nextCursor).toEqual(expect.any(String))
    const firstQuery = boxRepository.find.mock.calls[0][0]
    expect(firstQuery).toMatchObject({ order: { id: 'ASC' }, take: 2 })
    expect(firstQuery.where).toMatchObject({ organizationId: '11111111-1111-4111-8111-111111111111' })
    expect(Object.keys(firstQuery.select)).not.toEqual(
      expect.arrayContaining(['authToken', 'env', 'labels', 'networkAllowList', 'volumes', 'errorReason']),
    )
    if (!first.nextCursor) throw new Error('expected the first page to have a cursor')

    await expect(reader.boxes({ limit: 1, cursor: first.nextCursor })).resolves.toMatchObject({ items: [] })
    await expect(reader.runners({ limit: 1, cursor: first.nextCursor })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('returns Boxes across organization boundaries when no organization filter is present', async () => {
    const { reader, boxRepository } = repositories()
    boxRepository.find.mockResolvedValue([
      box('AbCdEf123456', '11111111-1111-4111-8111-111111111111'),
      box('BcDeFg234567', '44444444-4444-4444-8444-444444444444'),
    ])

    const page = await reader.boxes({ limit: 100 })

    expect(page.items.map((item) => item.organizationId)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '44444444-4444-4444-8444-444444444444',
    ])
    expect(boxRepository.find.mock.calls[0][0].where).not.toHaveProperty('organizationId')
  })

  it('filters Runners across custom regions without selecting credentials or origins', async () => {
    const { reader, runnerRepository, regionRepository } = repositories()
    regionRepository.find.mockResolvedValue([{ id: 'us-east' }])
    runnerRepository.find.mockResolvedValue([runner('22222222-2222-4222-8222-222222222222')])

    const page = await reader.runners({
      limit: 100,
      organizationId: '11111111-1111-4111-8111-111111111111',
      state: RunnerState.READY,
    })

    expect(page.items[0]).toMatchObject({ boxCount: 3, activeJobCount: 3, queueDepth: 1 })
    const query = runnerRepository.find.mock.calls[0][0]
    expect(query).toMatchObject({ order: { id: 'ASC' }, take: 101 })
    expect(Object.keys(query.select)).not.toEqual(
      expect.arrayContaining(['apiKey', 'domain', 'apiUrl', 'proxyUrl', 'serviceHealth']),
    )
  })

  it('intersects organization and region filters instead of widening either one', async () => {
    const { reader, runnerRepository, regionRepository } = repositories()
    regionRepository.find.mockResolvedValue([{ id: 'eu-west' }])

    const page = await reader.runners({
      limit: 100,
      organizationId: '11111111-1111-4111-8111-111111111111',
      regionId: 'us-east',
    })

    expect(page.items).toEqual([])
    expect(runnerRepository.find).not.toHaveBeenCalled()
  })

  it('returns bounded Box detail references without loading Job payloads', async () => {
    const { reader, boxRepository, jobRepository } = repositories()
    boxRepository.findOne.mockResolvedValue(box('AbCdEf123456'))
    jobRepository.find.mockResolvedValue(Array.from({ length: 201 }, (_, index) => ({ id: `job-${index}` })))

    const detail = await reader.box('AbCdEf123456')

    expect(detail.activeJobIds).toHaveLength(200)
    expect(detail.activeJobIdsTruncated).toBe(true)
    expect(jobRepository.find.mock.calls[0][0]).toMatchObject({ select: { id: true }, take: 201 })
  })

  it('returns bounded Runner impact references without loading Box or Job secrets', async () => {
    const { reader, boxRepository, runnerRepository, jobRepository } = repositories()
    runnerRepository.findOne.mockResolvedValue(runner('22222222-2222-4222-8222-222222222222'))
    boxRepository.find.mockResolvedValue(Array.from({ length: 201 }, (_, index) => ({ id: `box-${index}` })))
    jobRepository.find.mockResolvedValue(Array.from({ length: 201 }, (_, index) => ({ id: `job-${index}` })))

    const detail = await reader.runner('22222222-2222-4222-8222-222222222222')

    expect(detail.boxIds).toHaveLength(200)
    expect(detail.boxIdsTruncated).toBe(true)
    expect(detail.activeJobIds).toHaveLength(200)
    expect(detail.activeJobIdsTruncated).toBe(true)
    expect(boxRepository.find.mock.calls[0][0]).toMatchObject({ select: { id: true }, take: 201 })
    expect(jobRepository.find.mock.calls[0][0]).toMatchObject({ select: { id: true }, take: 201 })
  })

  it('fails safely for malformed cursors and missing details', async () => {
    const { reader, boxRepository, runnerRepository } = repositories()
    boxRepository.findOne.mockResolvedValue(null)
    runnerRepository.findOne.mockResolvedValue(null)
    const malformed = 'synthetic-malformed-cursor-value'

    await expect(reader.boxes({ limit: 100, cursor: malformed })).rejects.toMatchObject({
      message: 'Invalid pagination cursor',
    })
    await expect(reader.boxes({ limit: 100, cursor: malformed })).rejects.not.toThrow(malformed)
    await expect(reader.box('not-a-box-id')).rejects.toBeInstanceOf(BadRequestException)
    await expect(reader.runner('not-a-runner-id')).rejects.toBeInstanceOf(BadRequestException)
    await expect(reader.box('AbCdEf123456')).rejects.toBeInstanceOf(NotFoundException)
    await expect(reader.runner('22222222-2222-4222-8222-222222222222')).rejects.toBeInstanceOf(NotFoundException)
  })
})
