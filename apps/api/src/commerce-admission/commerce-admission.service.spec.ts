/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import axios from 'axios'
import { CommerceAdmissionService } from './commerce-admission.service'

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    isAxiosError: (error: any) => Boolean(error?.isAxiosError),
  },
}))

const post = axios.post as jest.Mock
const reservationId = '550e8400-e29b-41d4-a716-446655440000'

function service(enabled = true) {
  const config = {
    get: jest.fn().mockReturnValue({
      enabled,
      url: enabled ? 'https://commerce.test' : undefined,
      token: enabled ? 'token' : undefined,
      timeoutMs: 500,
    }),
  }
  return new CommerceAdmissionService(config as any)
}

const denied = {
  admission: false,
  reason: 'INSUFFICIENT_AVAILABLE_CREDIT',
  requiredCreditCents: '7',
  effectiveAvailableCreditCents: '3',
}

const allowed = {
  admission: true,
  reason: 'SUFFICIENT_AVAILABLE_CREDIT',
  reservationId,
  requiredCreditCents: '7',
  effectiveAvailableCreditCents: '100',
}

const resources = { cpu: 1, gpu: 0, mem: 1, disk: 10 }

function request(scenario: 'CREATE-BOX' | 'START-BOX', requestedResources = resources) {
  return { scenario, organizationId: 'org-1', resources: requestedResources }
}

describe('CommerceAdmissionService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-08-13T10:00:00.000Z') })
    post.mockReset()
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('does not cache an explicit organization denial', async () => {
    const admission = service()
    post.mockResolvedValue({ data: denied })

    await expect(admission.admit(request('CREATE-BOX'))).rejects.toMatchObject({
      status: 402,
      response: { statusCode: 402, message: 'INSUFFICIENT_AVAILABLE_CREDIT', error: 'Payment Required' },
    })
    await expect(admission.admit(request('START-BOX', { cpu: 1, gpu: 0, mem: 1, disk: 1 }))).rejects.toMatchObject({
      status: 402,
    })
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('retries a no-response failure with the same requestId, then blocks with 503', async () => {
    const admission = service()
    post
      .mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' })
      .mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNRESET', message: 'reset' })
      .mockResolvedValueOnce({ data: { released: true } })

    await expect(admission.admit(request('START-BOX'))).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'COMMERCE_ADMISSION_UNAVAILABLE' }),
    })
    jest.runAllTicks()
    await Promise.resolve()

    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[0][1].requestId).toBe(post.mock.calls[1][1].requestId)
    expect(post.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 250, maxRedirects: 0 }))
    expect(post.mock.calls[1][2]).toEqual(expect.objectContaining({ timeout: 500, maxRedirects: 0 }))
    expect(post.mock.calls[2][0]).toBe('https://commerce.test/internal/admission/release')
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('blocking START-BOX'))
  })

  it.each(['CREATE-BOX', 'START-BOX'] as const)(
    'accepts %s and sends the fixed contract inside the shared timeout budget',
    async (scenario) => {
      const admission = service()
      post.mockImplementation(async (_url, body) => ({ data: { ...allowed, reservationId: body.requestId } }))

      const result = await admission.admit(request(scenario, { cpu: 0.5, gpu: 1, mem: 4, disk: 20 }))
      expect(result).toEqual({
        organizationId: 'org-1',
        reservationId: post.mock.calls[0][1].requestId,
      })
      expect(post).toHaveBeenCalledWith(
        'https://commerce.test/internal/admission',
        expect.objectContaining({
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          scenario,
          organizationId: 'org-1',
          resources: { cpu: 0.5, gpu: 1, mem: 4, disk: 20 },
        }),
        expect.objectContaining({ timeout: 250, maxRedirects: 0 }),
      )
    },
  )

  it('maps a malformed 200 response to 502 and schedules a tombstone release', async () => {
    const admission = service()
    post
      .mockResolvedValueOnce({ data: { admission: false, reason: 'unknown' } })
      .mockResolvedValueOnce({ data: { released: true } })

    await expect(admission.admit(request('START-BOX'))).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({ code: 'COMMERCE_ADMISSION_UPSTREAM_ERROR' }),
    })
    jest.runAllTicks()
    await Promise.resolve()
    expect(post.mock.calls[1][0]).toBe('https://commerce.test/internal/admission/release')
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'))
  })

  it('retries HTTP 5xx and reuses the same requestId', async () => {
    const admission = service()
    post
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 }, message: 'unavailable' })
      .mockImplementationOnce(async (_url, body) => ({
        data: { ...allowed, reservationId: body.requestId },
      }))

    const result = await admission.admit(request('CREATE-BOX'))

    expect(result).toEqual({ organizationId: 'org-1', reservationId: post.mock.calls[0][1].requestId })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1][1]).toEqual(post.mock.calls[0][1])
  })

  it('fails open after the final HTTP 5xx but keeps an uncertain reservation handle', async () => {
    const admission = service()
    post.mockRejectedValue({ isAxiosError: true, response: { status: 500 }, message: 'server error' })

    const result = await admission.admit(request('START-BOX'))

    expect(result).toEqual({
      organizationId: 'org-1',
      reservationId: post.mock.calls[0][1].requestId,
    })
    expect(post).toHaveBeenCalledTimes(2)
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('allowing START-BOX'))
  })

  it.each([301, 400, 401, 403, 409, 429])('maps HTTP %s to 502 without retrying', async (status) => {
    const admission = service()
    post.mockRejectedValue({ isAxiosError: true, response: { status }, message: `HTTP ${status}` })

    await expect(admission.admit(request('START-BOX'))).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({ code: 'COMMERCE_ADMISSION_UPSTREAM_ERROR' }),
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('rejects an allowed decision whose reservationId differs from the requestId', async () => {
    const admission = service()
    post.mockResolvedValueOnce({ data: allowed }).mockResolvedValueOnce({ data: { released: true } })

    await expect(admission.admit(request('CREATE-BOX'))).rejects.toMatchObject({ status: 502 })
    jest.runAllTicks()
    await Promise.resolve()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('rejects an explicit stale-snapshot decision without caching it', async () => {
    const admission = service()
    post.mockResolvedValue({
      data: {
        admission: false,
        reason: 'STALE_USAGE_SNAPSHOT',
        requiredCreditCents: '7',
        effectiveAvailableCreditCents: '100',
      },
    })

    await expect(admission.admit(request('START-BOX'))).rejects.toMatchObject({
      status: 503,
      response: { statusCode: 503, message: 'STALE_USAGE_SNAPSHOT', error: 'Service Unavailable' },
    })
    await expect(admission.admit(request('START-BOX'))).rejects.toMatchObject({
      status: 503,
    })
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('does nothing when Commerce admission is not configured', async () => {
    const admission = service(false)

    await expect(admission.admit(request('START-BOX'))).resolves.toBeNull()
    expect(post).not.toHaveBeenCalled()
  })

  it('best-effort releases an accepted reservation', async () => {
    const admission = service()
    post.mockResolvedValue({ data: { released: true } })

    await admission.release({ organizationId: 'org-1', reservationId })

    expect(post).toHaveBeenCalledWith(
      'https://commerce.test/internal/admission/release',
      { organizationId: 'org-1', reservationId },
      expect.objectContaining({ timeout: 250, maxRedirects: 0 }),
    )
  })

  it('retries an idempotent release on HTTP 5xx within its own total budget', async () => {
    const admission = service()
    post
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 }, message: 'unavailable' })
      .mockResolvedValueOnce({ data: { released: true } })

    await admission.release({ organizationId: 'org-1', reservationId })

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1][1]).toEqual(post.mock.calls[0][1])
  })
})
