/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { TurnstileService } from './turnstile.service'

const SECRET = 'private-turnstile-secret'
const TOKEN = 'private-one-use-response'

describe('TurnstileService Siteverify boundary', () => {
  let service: TurnstileService
  let fetchMock: jest.SpyInstance
  let warnings: jest.SpyInstance
  let debug: jest.SpyInstance
  let settings: { secretKey: string; expectedHostnames: string[]; action: string; timeoutMs: number }

  beforeEach(() => {
    settings = { secretKey: SECRET, expectedHostnames: ['console.example.com'], action: 'signup', timeoutMs: 5000 }
    service = new TurnstileService({ getOrThrow: () => settings } as never)
    fetchMock = jest.spyOn(globalThis, 'fetch')
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
  })

  afterEach(() => {
    const logs = JSON.stringify([...warnings.mock.calls, ...debug.mock.calls])
    expect(logs).not.toContain(SECRET)
    expect(logs).not.toContain(TOKEN)
    jest.restoreAllMocks()
  })

  const respond = (body: unknown, status = 200) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }))
  }

  it('sends one server-side verification request and accepts an exact hostname and action', async () => {
    respond({ success: true, action: 'signup', hostname: 'console.example.com' })
    await expect(service.verify(TOKEN)).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(options.body)).toEqual({ secret: SECRET, response: TOKEN })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(debug).toHaveBeenCalledWith({
      event: 'registration.verification',
      outcome: 'success',
      durationMs: expect.any(Number),
    })
  })

  it.each([
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: false, 'error-codes': ['invalid-input-response'] },
    { success: false, 'error-codes': ['missing-input-response'] },
    { success: true, action: 'login', hostname: 'console.example.com' },
    { success: true, action: 'signup', hostname: 'unlisted.example.com' },
    { success: true, action: 'signup', hostname: 'console.example.com.attacker.test' },
    { success: true, action: 'signup', hostname: 'console.example.com:443' },
    { success: true, hostname: 'console.example.com' },
    { success: true, action: 'signup' },
  ])('rejects an unsuccessful or mismatched challenge', async (body) => {
    respond(body)
    await expect(service.verify(TOKEN)).rejects.toMatchObject({
      status: 403,
      response: { code: 'turnstile_verification_failed' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveBeenCalledWith({
      event: 'registration.verification',
      outcome: 'rejected',
      durationMs: expect.any(Number),
    })
  })

  it('accepts each explicitly configured hostname', async () => {
    settings.expectedHostnames.push('other.example.com')
    respond({ success: true, action: 'signup', hostname: 'other.example.com' })
    await expect(service.verify(TOKEN)).resolves.toBeUndefined()
  })

  it.each(['missing-input-secret', 'invalid-input-secret', 'internal-error', 'bad-request'])(
    'maps server failure %s to 503',
    async (code) => {
      respond({ success: false, 'error-codes': [code], message: `${SECRET} ${TOKEN}` })
      await expect(service.verify(TOKEN)).rejects.toMatchObject({
        status: 503,
        response: { code: 'turnstile_unavailable' },
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it.each([null, {}, [], { success: 'true' }, { success: 1 }])('maps an invalid success field to 503', async (body) => {
    respond(body)
    await expect(service.verify(TOKEN)).rejects.toMatchObject({
      status: 503,
      response: { code: 'turnstile_unavailable' },
    })
  })

  it('maps malformed JSON to 503 without exposing the upstream response', async () => {
    fetchMock.mockResolvedValue(new Response(`not-json ${SECRET} ${TOKEN}`))
    await expect(service.verify(TOKEN)).rejects.toMatchObject({
      status: 503,
      response: { code: 'turnstile_unavailable' },
    })
  })

  it.each([400, 429, 500])('maps upstream HTTP %i to 503 without retrying', async (status) => {
    respond({ message: `${SECRET} ${TOKEN}` }, status)
    await expect(service.verify(TOKEN)).rejects.toMatchObject({
      status: 503,
      response: { code: 'turnstile_unavailable' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a network failure to 503 without exposing its details', async () => {
    fetchMock.mockRejectedValue(new Error(`connection reset ${SECRET} ${TOKEN}`))
    await expect(service.verify(TOKEN)).rejects.toMatchObject({
      status: 503,
      response: { code: 'turnstile_unavailable', message: 'Verification is temporarily unavailable' },
    })
  })

  it('aborts verification at the configured timeout and returns 503', async () => {
    settings.timeoutMs = 5
    fetchMock.mockImplementation(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        }),
    )

    await expect(service.verify(TOKEN)).rejects.toMatchObject({
      status: 503,
      response: { code: 'turnstile_unavailable' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveBeenCalledWith({
      event: 'registration.verification',
      outcome: 'timeout',
      durationMs: expect.any(Number),
    })
  })
})
