/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { OrganizationConcurrencyService } from './organization-concurrency.service'

describe('OrganizationConcurrencyService', () => {
  const boxRepository = { count: jest.fn() }
  const quotaRepository = { findOne: jest.fn(), upsert: jest.fn() }
  const sampleRepository = { find: jest.fn(), findOne: jest.fn(), save: jest.fn(), delete: jest.fn() }
  const service = new OrganizationConcurrencyService(
    boxRepository as any,
    quotaRepository as any,
    sampleRepository as any,
  )

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('records a new authoritative count only when it changes', async () => {
    boxRepository.count.mockResolvedValue(4)
    sampleRepository.findOne.mockResolvedValue({ runningBoxes: 3 })
    sampleRepository.save.mockImplementation(async (sample) => sample)

    await service.recordCurrent('org-1')

    expect(boxRepository.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', state: expect.anything() },
    })
    expect(sampleRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', runningBoxes: 4 }),
    )

    sampleRepository.findOne.mockResolvedValue({ runningBoxes: 4 })
    await service.recordCurrent('org-1')
    expect(sampleRepository.save).toHaveBeenCalledTimes(1)
  })

  it('returns the effective limit, current count, and a bounded history', async () => {
    const from = new Date('2026-08-18T00:00:00.000Z')
    const to = new Date('2026-08-19T00:00:00.000Z')
    boxRepository.count.mockResolvedValue(5)
    quotaRepository.findOne.mockResolvedValue({ maxConcurrentBoxes: 20 })
    sampleRepository.findOne.mockResolvedValue({ observedAt: new Date('2026-08-17T23:00:00.000Z'), runningBoxes: 2 })
    sampleRepository.find.mockResolvedValue([{ observedAt: new Date('2026-08-18T06:00:00.000Z'), runningBoxes: 3 }])

    await expect(service.getConcurrency('org-1', from, to)).resolves.toEqual({
      current: 5,
      limit: 20,
      points: [
        { observedAt: from, runningBoxes: 2 },
        { observedAt: new Date('2026-08-18T06:00:00.000Z'), runningBoxes: 3 },
        { observedAt: to, runningBoxes: 5 },
      ],
    })
  })

  it('accepts an unlimited entitlement from the billing role delivery path', async () => {
    quotaRepository.upsert.mockResolvedValue(undefined)

    await service.setEntitlement('org-1', null)

    expect(quotaRepository.upsert).toHaveBeenCalledWith({ organizationId: 'org-1', maxConcurrentBoxes: null }, [
      'organizationId',
    ])
  })

  it('reports an explicit null entitlement as unlimited', async () => {
    const from = new Date('2026-08-18T00:00:00.000Z')
    const to = new Date('2026-08-19T00:00:00.000Z')
    boxRepository.count.mockResolvedValue(5)
    quotaRepository.findOne.mockResolvedValue({ maxConcurrentBoxes: null })
    sampleRepository.findOne.mockResolvedValue(null)
    sampleRepository.find.mockResolvedValue([])

    await expect(service.getConcurrency('org-1', from, to)).resolves.toMatchObject({ limit: null })
  })

  it('counts every state that occupies an admission slot', async () => {
    boxRepository.count.mockResolvedValue(0)
    sampleRepository.findOne.mockResolvedValue(null)
    await service.recordCurrent('org-1')

    const states = boxRepository.count.mock.calls[0][0].where.state._value
    expect(states).toEqual(
      expect.arrayContaining([
        BoxState.CREATING,
        BoxState.RESTORING,
        BoxState.STARTING,
        BoxState.STARTED,
        BoxState.STOPPING,
        BoxState.UNKNOWN,
      ]),
    )
  })
})
