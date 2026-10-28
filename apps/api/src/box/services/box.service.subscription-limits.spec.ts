/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { BoxService } from './box.service'
import { RunnerState } from '../enums/runner-state.enum'
import { Context } from '../../common/context/context'
import { createBoxToCreateBox } from '../../boxlite-rest/mappers/box-to-box.mapper'
import { OrganizationController } from '../../organization/controllers/organization.controller'
import { Organization } from '../../organization/entities/organization.entity'

const baseline = { maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 }
const subscribed = { maxCpuPerBox: 16, maxMemoryPerBox: 32, maxDiskPerBox: 100 }
const organization = { id: 'org-1', ...baseline } as Organization

describe('subscription Box resource limits', () => {
  const resolve = jest.fn()
  const insert = jest.fn(async (box) => box)
  let service: BoxService

  beforeEach(() => {
    jest.clearAllMocks()
    resolve.mockResolvedValue(subscribed)
    service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, {
      getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'region-1' }),
      getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
      organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
      organizationBoxLimits: { resolve },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      runnerService: {
        getRandomAvailableRunner: jest.fn().mockResolvedValue({ id: 'runner-1', state: RunnerState.READY }),
      },
      boxRepository: { insert },
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      toBoxDto: jest.fn((box) => box),
      imageAdmissionService: { assert: jest.fn(), spendColdPullBudget: jest.fn() },
      imageResolverService: { resolve: jest.fn().mockResolvedValue({ ref: 'example/app:latest', isOrgOwned: true }) },
    })
  })

  const request = (cpus = 16, memory_mib = 32768, disk_size_gb = 100) =>
    createBoxToCreateBox({ image: 'example/app:latest', cpus, memory_mib, disk_size_gb })

  it.each([
    [2, 4096, 20],
    [4, 8192, 50],
    [16, 32768, 100],
  ])('persists subscriber resources %s/%s/%s from REST', async (cpu, memory, disk) => {
    await service.create(request(cpu, memory, disk), organization, Context.user())
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ cpu, mem: memory / 1024, disk }), undefined)
    expect(organization).toMatchObject(baseline)
  })

  it.each([
    [17, 32768, 100, /cpu 17.*limit of 16/],
    [16, 33792, 100, /memory 33GB.*limit of 32GB/],
    [16, 32768, 101, /disk 101GB.*limit of 100GB/],
  ])('rejects subscriber overflow %s/%s/%s before persistence', async (cpu, memory, disk, error) => {
    await expect(service.create(request(cpu, memory, disk), organization, Context.user())).rejects.toThrow(error)
    expect(insert).not.toHaveBeenCalled()
  })

  it('rechecks the entitlement after cancellation instead of retaining the previous grant', async () => {
    await service.create(request(), organization, Context.user())
    resolve.mockResolvedValue(baseline)
    insert.mockClear()
    await expect(service.create(request(2, 4096, 20), organization, Context.user())).rejects.toThrow(/disk 20GB/)
    expect(insert).not.toHaveBeenCalled()
  })

  it('lists stored quotas without resolving grants and resolves only the requested detail', async () => {
    const custom = { ...organization, id: 'org-custom', maxDiskPerBox: 200 }
    const controller = Object.create(OrganizationController.prototype) as OrganizationController
    Object.assign(controller, {
      organizationBoxLimits: { resolve },
      organizationService: {
        findOne: jest.fn().mockResolvedValue(organization),
        findByUserWithDefaultFlag: jest.fn().mockResolvedValue([
          { organization, isDefaultForAuthenticatedUser: true },
          { organization: custom, isDefaultForAuthenticatedUser: false },
        ]),
      },
    })
    expect(await controller.findAll({ userId: 'user-1' } as never)).toEqual([
      expect.objectContaining({ id: 'org-1', ...baseline, isDefaultForAuthenticatedUser: true, personal: true }),
      expect.objectContaining({
        id: 'org-custom',
        ...baseline,
        maxDiskPerBox: 200,
        isDefaultForAuthenticatedUser: false,
        personal: false,
      }),
    ])
    expect(resolve).not.toHaveBeenCalled()
    expect(await controller.findOne('org-1')).toMatchObject(subscribed)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith(organization)
    expect(organization).toMatchObject(baseline)
  })
})
