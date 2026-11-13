/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { BoxService } from './box.service'
import { BoxWarmPoolService } from './box-warm-pool.service'
import { Box } from '../entities/box.entity'
import { BoxDto } from '../dto/box.dto'
import { ListBoxesQueryDto } from '../dto/list-boxes-query.dto'
import { BoxState } from '../enums/box-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerAdapterV0 } from '../runner-adapter/runnerAdapter.v0'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'
import { Context } from '../../common/context/context'
import { Organization } from '../../organization/entities/organization.entity'
import { boxToBoxResponse, createBoxToCreateBox } from '../../boxlite-rest/mappers/box-to-box.mapper'
import { expectedOpenPeriod } from '../../usage/services/expected-usage-period'
import { toUsageEventDto, usageEventKey } from '../../usage/usage-event'
import { toOpenAllocationDto } from '../../usage/open-allocation'

const organization = { id: 'org-memory' } as Organization

describe('Cloud MiB allocation regression', () => {
  const insert = jest.fn(async (box) => box)
  let service: BoxService

  beforeEach(() => {
    insert.mockClear()
    service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, {
      getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'us' }),
      getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
      organizationService: {
        assertOrganizationIsNotSuspended: jest.fn(),
        isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(false),
      },
      organizationBoxLimits: {
        resolve: jest.fn().mockResolvedValue({ maxCpuPerBox: 16, maxMemoryPerBox: 32, maxDiskPerBox: 100 }),
      },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      runnerService: {
        getRandomAvailableRunner: jest.fn().mockResolvedValue({ id: 'runner-memory', state: RunnerState.READY }),
      },
      boxRepository: { insert },
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      toBoxDto: jest.fn((box) => BoxDto.fromBox(box)),
      imageAdmissionService: { assert: jest.fn(), spendColdPullBudget: jest.fn() },
      imageResolverService: { resolve: jest.fn().mockResolvedValue({ ref: 'example/app:latest', isOrgOwned: true }) },
    })
  })

  it.each([128, 300, 512, 1536])(
    'creates and returns exactly %s MiB through the REST and service boundary',
    async (memory_mib) => {
      const response = await service.create(
        createBoxToCreateBox({ image: 'example/app:latest', memory_mib }),
        organization,
        Context.user(),
      )
      expect(boxToBoxResponse(response).memory_mib).toBe(memory_mib)
      expect(insert.mock.calls[0][0]).toMatchObject({ memoryMib: memory_mib, mem: Math.ceil(memory_mib / 1024) })
    },
  )

  it('admits 300 MiB under a half-GiB organization limit', async () => {
    Object.assign(service, {
      organizationBoxLimits: { resolve: jest.fn().mockResolvedValue({ maxMemoryPerBox: 0.5 }) },
    })
    await expect(
      service.create(createBoxToCreateBox({ memory_mib: 300 }), organization, Context.user()),
    ).resolves.toMatchObject({ memory: 300 / 1024 })
  })

  it('uses the exact allocation in persisted-Box responses and metering', () => {
    const box = Object.assign(new Box('us'), { mem: 1, memoryMib: 300, state: BoxState.STARTED })
    expect(boxToBoxResponse(BoxDto.fromBox(box)).memory_mib).toBe(300)
    expect(expectedOpenPeriod(box)?.mem).toBe(300 / 1024)
  })

  it('passes exact GiB to V0 create and recovery', async () => {
    const adapter = new RunnerAdapterV0()
    const create = jest.fn().mockResolvedValue({ data: {} })
    const recover = jest.fn().mockResolvedValue(undefined)
    Object.assign(adapter, { boxApiClient: { create, recover } })
    const box = Object.assign(new Box('us'), { mem: 1, memoryMib: 300 })
    await adapter.createBox(box, 'alpine:latest')
    await adapter.recoverBox(box)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ memoryQuota: 300 / 1024 }))
    expect(recover).toHaveBeenCalledWith(box.id, expect.objectContaining({ memoryQuota: 300 / 1024 }))
  })

  it('passes exact GiB to V2 create jobs', async () => {
    const createJob = jest.fn().mockResolvedValue(undefined)
    const adapter = new RunnerAdapterV2({} as never, {} as never, { createJob } as never)
    await adapter.init({ id: 'runner-memory' } as never)
    await adapter.createBox(Object.assign(new Box('us'), { mem: 1, memoryMib: 300 }), 'alpine:latest')
    expect(createJob.mock.calls[0][5].memoryQuota).toBe(300 / 1024)
  })

  it('bypasses integer warm pools and their miss cache for fractional GiB', async () => {
    const findOne = jest.fn().mockResolvedValue(null)
    const set = jest.fn()
    const pools = Object.create(BoxWarmPoolService.prototype) as BoxWarmPoolService
    Object.assign(pools, { warmPoolRepository: { findOne }, redis: { set } })
    await pools.fetchWarmPoolBox({ mem: 300 / 1024, image: 'alpine:latest' } as never)
    expect(findOne).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('accepts fractional GiB range filters', async () => {
    const query = plainToInstance(ListBoxesQueryDto, { minMemoryGiB: 0.125, maxMemoryGiB: 0.125 })
    expect(await validate(query)).toEqual([])
  })
})

describe('memory billing output contract', () => {
  const period = (mem: number) => ({
    organizationId: 'org-memory',
    boxId: 'box-memory',
    region: 'us',
    startAt: new Date('2026-11-01T00:00:00Z'),
    endAt: new Date('2026-11-01T01:00:00Z'),
    cpu: 1,
    gpu: 0,
    mem,
    disk: 10,
  })

  it.each([
    [300, '0.29'],
    [639, '0.62'],
    [640, '0.63'],
    [641, '0.63'],
  ] as const)('rounds %s MiB half-up to %s GiB in both output paths', (mib, expected) => {
    const source = period(mib / 1024)
    expect(toUsageEventDto(source).mem).toBe(expected)
    expect(toOpenAllocationDto(source).mem).toBe(expected)
    expect(source.mem).toBe(mib / 1024)
  })

  it('keeps exact source identities when billing quantities round together', () => {
    const first = toUsageEventDto(period(300 / 1024))
    const second = toUsageEventDto(period(301 / 1024))
    expect(first.mem).toBe(second.mem)
    expect(first.eventKey).not.toBe(second.eventKey)
    expect(first.eventKey).toBe(usageEventKey(period(300 / 1024)))
  })
})
