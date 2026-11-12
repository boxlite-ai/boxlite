/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { GoogleError } from 'google-gax'
import { GcpDiskClient, GcpDiskRateLimitedError, toExpansionClientError } from './gcp-disk-client'
import { RunnerDataDiskRef } from '../common/runner-data-disk-ref'

const ref: RunnerDataDiskRef = { provider: 'gcp', project: 'proj', zone: 'z1', diskName: 'disk-1' }

function fakeDisks(result: () => Promise<{ name: string }[]>) {
  const update = jest.fn(result)
  return { update, client: { update } }
}

describe('GcpDiskClient', () => {
  describe('resizeDisk', () => {
    it('sends paths=["sizeGb"] and the numeric size, and returns the operation name', async () => {
      const disks = fakeDisks(async () => [{ name: 'operation-123' }])
      const client = new GcpDiskClient({ disks: disks.client })

      const result = await client.resizeDisk(ref, 4096)

      expect(result).toEqual({ operation: 'operation-123' })
      // paths must be exactly ["sizeGb"]: the v1 client ignores updateMask,
      // and a request without paths is a full PATCH that would reset
      // provisioned IOPS/throughput to defaults. The body must also carry
      // the disk name: disks.update requires resource.name even though the
      // mask only names sizeGb.
      expect(disks.update).toHaveBeenCalledWith({
        project: 'proj',
        zone: 'z1',
        disk: 'disk-1',
        diskResource: { name: 'disk-1', sizeGb: '4096' },
        paths: ['sizeGb'],
      })
    })

    it.each([
      [
        'a GCP rate-limit rejection (HTTP 429, reason rateLimitExceeded)',
        GoogleError.parseHttpError({
          error: {
            code: 429,
            errors: [
              { domain: 'global', message: 'Quota exceeded for requests per minute', reason: 'rateLimitExceeded' },
            ],
            message: 'Quota exceeded for requests per minute',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        true,
      ],
      [
        'a genuine request-validation 400 (INVALID_ARGUMENT)',
        GoogleError.parseHttpError({ error: { code: 400, message: 'New size must be larger' } }),
        false,
      ],
      ['a transport 5xx', GoogleError.parseHttpError({ error: { code: 500, message: 'backend error' } }), false],
      ['a 404 for a replaced disk', GoogleError.parseHttpError({ error: { code: 404, message: 'not found' } }), false],
    ])('maps %s to the right error class', async (_label, error, rateLimited) => {
      const disks = fakeDisks(() => Promise.reject(error))
      const client = new GcpDiskClient({ disks: disks.client })

      await expect(client.resizeDisk(ref, 100)).rejects.toThrow(rateLimited ? GcpDiskRateLimitedError : Error)
    })
  })

  describe('getZoneOperation', () => {
    it.each([
      ['still running', { status: 'RUNNING' }, { status: 'RUNNING' }],
      [
        'failed with errors',
        { status: 'DONE', error: { errors: [{ code: 'QUOTA_EXCEEDED', message: 'no room' }] } },
        { status: 'DONE', error: 'QUOTA_EXCEEDED: no room' },
      ],
      ['done without error', { status: 'DONE' }, { status: 'DONE' }],
    ])('normalizes %s', async (_label, raw, expected) => {
      const zoneOperations = {
        get: jest.fn(async () => [raw]),
      }
      const client = new GcpDiskClient({ zoneOperations })

      await expect(client.getZoneOperation(ref, 'operation-123')).resolves.toEqual(expected)
      expect(zoneOperations.get).toHaveBeenCalledWith({ project: 'proj', zone: 'z1', operation: 'operation-123' })
    })
  })

  describe('toExpansionClientError', () => {
    it('labels the throttle signal (RESOURCE_EXHAUSTED) as rate limited and passes everything else through', () => {
      const throttled = GoogleError.parseHttpError({
        error: { code: 429, message: 'Quota exceeded for requests per minute', status: 'RESOURCE_EXHAUSTED' },
      })
      expect(toExpansionClientError(throttled)).toBeInstanceOf(GcpDiskRateLimitedError)
      // A genuine 400 arrives as INVALID_ARGUMENT (3): a real validation
      // rejection, never a throttle signal.
      const invalid = GoogleError.parseHttpError({ error: { code: 400, message: 'New size must be larger' } })
      const other = toExpansionClientError(invalid)
      expect(other).toBeInstanceOf(Error)
      expect(other).not.toBeInstanceOf(GcpDiskRateLimitedError)
      expect(other.message).toBe('New size must be larger')
      const plain = toExpansionClientError(new Error('boom'))
      expect(plain).toBeInstanceOf(Error)
      expect(plain).not.toBeInstanceOf(GcpDiskRateLimitedError)
      expect(plain.message).toBe('boom')
    })
  })
})
