/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BoxAdmissionReservationLostError,
  BoxAdmissionReservationService,
  withBoxAdmissionReservation,
} from './box-admission-reservation.service'

describe('BoxAdmissionReservationService', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('keeps a slow creation reserved beyond the original TTL', async () => {
    jest.useFakeTimers()
    const redis = { eval: jest.fn().mockResolvedValue(1) }
    const service = new BoxAdmissionReservationService(redis as any)
    const reservation = await service.reserve('org-1')
    let finishCreation!: () => void

    const creation = withBoxAdmissionReservation(
      reservation,
      () =>
        new Promise<string>((resolve) => {
          finishCreation = () => resolve('box-1')
        }),
    )

    await jest.advanceTimersByTimeAsync(31_000)

    expect(reservation.signal.aborted).toBe(false)
    expect(redis.eval).toHaveBeenCalledTimes(3)
    expect(redis.eval.mock.calls[1][0]).toContain("redis.call('ZADD', KEYS[1], 'XX'")
    expect(redis.eval.mock.calls[2][0]).toContain("redis.call('ZADD', KEYS[1], 'XX'")

    finishCreation()
    await expect(creation).resolves.toBe('box-1')
    expect(redis.eval).toHaveBeenCalledTimes(4)
  })

  it('aborts when renewal reports ownership loss', async () => {
    jest.useFakeTimers()
    const redis = {
      eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(0),
    }
    const service = new BoxAdmissionReservationService(redis as any)
    const reservation = await service.reserve('org-1')

    await jest.advanceTimersByTimeAsync(15_000)

    expect(reservation.signal.aborted).toBe(true)
    expect(reservation.signal.reason).toBeInstanceOf(BoxAdmissionReservationLostError)
    await expect(reservation.release()).rejects.toBeInstanceOf(BoxAdmissionReservationLostError)
  })

  it('aborts a stalled renewal with time remaining before token expiry', async () => {
    jest.useFakeTimers()
    const redis = {
      eval: jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockImplementation(() => new Promise(() => undefined)),
    }
    const service = new BoxAdmissionReservationService(redis as any)
    const reservation = await service.reserve('org-1')

    await jest.advanceTimersByTimeAsync(16_000)

    expect(reservation.signal.aborted).toBe(true)
    expect(reservation.signal.reason).toEqual(
      expect.objectContaining({ message: 'Redis box admission renewal timed out' }),
    )
    const release = expect(reservation.release()).rejects.toThrow('renewal timed out')
    await jest.advanceTimersByTimeAsync(1_000)
    await release
  })

  it('preserves the creation error when release also fails', async () => {
    const creationError = new Error('creation failed')
    const releaseError = new Error('release failed')
    const onSuppressedReleaseError = jest.fn()
    const reservation = {
      signal: new AbortController().signal,
      release: jest.fn().mockRejectedValue(releaseError),
    }

    await expect(
      withBoxAdmissionReservation(
        reservation as any,
        async () => {
          throw creationError
        },
        onSuppressedReleaseError,
      ),
    ).rejects.toBe(creationError)
    expect(onSuppressedReleaseError).toHaveBeenCalledWith(releaseError)
  })
})
