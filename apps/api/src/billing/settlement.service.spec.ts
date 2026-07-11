/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SettlementService } from './settlement.service'

describe('SettlementService', () => {
  it('rates archived usage before debiting rated periods', async () => {
    const order: string[] = []
    const ratingService = {
      async rateClosedPeriods() {
        order.push('rating')
        return { rated: 2, skipped: 1 }
      },
    }
    const walletService = {
      async debitRatedPeriods() {
        order.push('wallet')
        return { debited: 2, skipped: 0 }
      },
    }
    const service = new SettlementService(ratingService as never, walletService as never)

    await expect(service.settleClosedPeriods()).resolves.toEqual({
      rated: 2,
      ratingSkipped: 1,
      debited: 2,
      debitSkipped: 0,
    })
    expect(order).toEqual(['rating', 'wallet'])
  })

  it('does not debit when rating fails', async () => {
    const walletService = { debitRatedPeriods: jest.fn() }
    const service = new SettlementService(
      { rateClosedPeriods: jest.fn().mockRejectedValue(new Error('rating unavailable')) } as never,
      walletService as never,
    )

    await expect(service.settleClosedPeriods()).rejects.toThrow('rating unavailable')
    expect(walletService.debitRatedPeriods).not.toHaveBeenCalled()
  })

  it('finishes the debit on the next sweep when a worker stops after rating', async () => {
    const ratingService = {
      rateClosedPeriods: jest
        .fn()
        .mockResolvedValueOnce({ rated: 1, skipped: 0 })
        .mockResolvedValueOnce({ rated: 0, skipped: 1 }),
    }
    const walletService = {
      debitRatedPeriods: jest
        .fn()
        .mockRejectedValueOnce(new Error('database connection lost'))
        .mockResolvedValueOnce({ debited: 1, skipped: 0 }),
    }
    const service = new SettlementService(ratingService as never, walletService as never)

    await expect(service.settleClosedPeriods()).rejects.toThrow('database connection lost')
    await expect(service.settleClosedPeriods()).resolves.toEqual({
      rated: 0,
      ratingSkipped: 1,
      debited: 1,
      debitSkipped: 0,
    })

    expect(ratingService.rateClosedPeriods).toHaveBeenCalledTimes(2)
    expect(walletService.debitRatedPeriods).toHaveBeenCalledTimes(2)
  })
})
