/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios from 'axios'
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { SshAccessSetAdapter } from './ssh-access-set.adapter'
import { Runner } from '../entities/runner.entity'

jest.mock('axios')

const mockedAxios = axios as unknown as { put: jest.Mock; isAxiosError: jest.Mock }

function makeRunner(overrides: Partial<Runner> = {}): Runner {
  return {
    apiUrl: 'https://runner.example',
    apiKey: 'runner-key',
    ...overrides,
  } as Runner
}

function makeConfigService(timeoutSeconds = 10) {
  return { get: jest.fn().mockReturnValue(timeoutSeconds) } as any
}

function axiosErrorWithStatus(status: number, data?: unknown) {
  return { isAxiosError: true, message: 'Request failed', response: { status, data } }
}

const boxId = 'box-1'
const entry = {
  id: 'cred-1',
  grantId: 'grant-1',
  publicKey: 'ssh-ed25519 AAAA',
  fingerprint: 'SHA256:abc',
  unixUser: 'root',
  expiresAt: new Date('2026-01-01T00:00:00Z'),
}

describe('SshAccessSetAdapter', () => {
  beforeEach(() => {
    mockedAxios.put = jest.fn()
    mockedAxios.isAxiosError = jest.fn((err: any) => !!err?.isAxiosError)
  })

  it('applies the access set and returns the typed status on success', async () => {
    mockedAxios.put.mockResolvedValue({
      data: {
        appliedGeneration: 3,
        listenerReady: true,
        hostPublicKey: 'ssh-ed25519 HOST',
        hostKeyFingerprint: 'SHA256:host',
      },
    })

    const adapter = new SshAccessSetAdapter(makeConfigService(7))
    const status = await adapter.applyAccessSet(makeRunner(), boxId, 3, [entry])

    expect(status).toEqual({
      appliedGeneration: 3,
      listenerReady: true,
      hostPublicKey: 'ssh-ed25519 HOST',
      hostKeyFingerprint: 'SHA256:host',
    })
    expect(mockedAxios.put).toHaveBeenCalledWith(
      'https://runner.example/v1/boxes/box-1/ssh/access-set',
      {
        generation: 3,
        accesses: [
          {
            id: 'cred-1',
            grantId: 'grant-1',
            publicKey: 'ssh-ed25519 AAAA',
            fingerprint: 'SHA256:abc',
            unixUser: 'root',
            expiresAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      { headers: { Authorization: 'Bearer runner-key' }, timeout: 7000 },
    )
  })

  it.each([
    [HttpStatus.NOT_FOUND, NotFoundException],
    [HttpStatus.BAD_REQUEST, BadRequestException],
    [HttpStatus.CONFLICT, ConflictException],
    [HttpStatus.SERVICE_UNAVAILABLE, ServiceUnavailableException],
    // Unmapped statuses (e.g. a plain 500) fall through to retryable 503 too,
    // per the design's "never claim success without guest ack" contract.
    [HttpStatus.INTERNAL_SERVER_ERROR, ServiceUnavailableException],
  ])('maps Runner status %d to %p', async (status, ExceptionClass) => {
    mockedAxios.put.mockRejectedValue(axiosErrorWithStatus(status, { error: 'boom' }))
    const adapter = new SshAccessSetAdapter(makeConfigService())

    await expect(adapter.applyAccessSet(makeRunner(), boxId, 1, [])).rejects.toBeInstanceOf(ExceptionClass)
  })

  it('maps a 429 to a TOO_MANY_REQUESTS HttpException', async () => {
    mockedAxios.put.mockRejectedValue(axiosErrorWithStatus(429, { error: 'rate limited' }))
    const adapter = new SshAccessSetAdapter(makeConfigService())

    const error = await adapter.applyAccessSet(makeRunner(), boxId, 1, []).catch((e) => e)
    expect(error).toBeInstanceOf(HttpException)
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS)
  })

  it('maps a no-response network error to ServiceUnavailableException', async () => {
    mockedAxios.put.mockRejectedValue({ isAxiosError: true, message: 'ECONNREFUSED' })
    const adapter = new SshAccessSetAdapter(makeConfigService())

    await expect(adapter.applyAccessSet(makeRunner(), boxId, 1, [])).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('rejects with NotFoundException without calling the Runner when apiUrl is missing', async () => {
    const adapter = new SshAccessSetAdapter(makeConfigService())

    await expect(adapter.applyAccessSet(makeRunner({ apiUrl: null }), boxId, 1, [])).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })
})
