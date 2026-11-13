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
  return { update, client: { update, get: jest.fn(async () => []) } }
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

  describe('resizeDisk performance fields', () => {
    // The four request shapes the design pins. A mask that omits a carried
    // field would reset that field to the cloud default; a full PATCH is the
    // original reset hazard this invariant exists against.
    it.each([
      [
        'size only',
        undefined,
        ['sizeGb'],
        { name: 'disk-1', sizeGb: '4096' },
      ],
      [
        'size + both performance fields',
        { iops: '5400', throughput: '360' },
        ['sizeGb', 'provisionedIops', 'provisionedThroughput'],
        { name: 'disk-1', sizeGb: '4096', provisionedIops: '5400', provisionedThroughput: '360' },
      ],
      [
        'size + IOPS only',
        { iops: '7200' },
        ['sizeGb', 'provisionedIops'],
        { name: 'disk-1', sizeGb: '4096', provisionedIops: '7200' },
      ],
      [
        'size + throughput only',
        { throughput: '480' },
        ['sizeGb', 'provisionedThroughput'],
        { name: 'disk-1', sizeGb: '4096', provisionedThroughput: '480' },
      ],
    ])('sends $0', async (_label, performance, expectedPaths, expectedResource) => {
      const update = jest.fn(async () => [{ name: 'operation-1' }])
      const client = new GcpDiskClient({ disks: { update, get: jest.fn(async () => []) } })

      await client.resizeDisk(ref, 4096, performance)

      // objectContaining keeps other keys loose, but the paths array inside
      // it matches exactly, pinning the mask per shape.
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ diskResource: expectedResource, paths: expectedPaths }),
      )
    })

    it('rejects exactly like a size-only update when the transport fails', async () => {
      const throttled = GoogleError.parseHttpError({
        error: { code: 429, message: 'rate', status: 'RESOURCE_EXHAUSTED' },
      })
      const update = jest.fn(() => Promise.reject(throttled))
      const client = new GcpDiskClient({ disks: { update, get: jest.fn(async () => []) } })

      await expect(client.resizeDisk(ref, 4096, { iops: '5400' })).rejects.toThrow(GcpDiskRateLimitedError)
    })
  })

  describe('getDisk', () => {
    it('returns the baseline with int64 values normalized to strings', async () => {
      const get = jest.fn(async () => [
        { sizeGb: 200, provisionedIops: '3600', provisionedThroughput: 240 },
      ])
      const client = new GcpDiskClient({ disks: { get, update: jest.fn() } })

      await expect(client.getDisk(ref)).resolves.toEqual({
        sizeGb: '200',
        provisionedIops: '3600',
        provisionedThroughput: '240',
      })
      expect(get).toHaveBeenCalledWith({ project: 'proj', zone: 'z1', disk: 'disk-1' })
    })

    it('leaves absent provisioned values undefined instead of guessing', async () => {
      const get = jest.fn(async () => [{ sizeGb: '200' }])
      const client = new GcpDiskClient({ disks: { get, update: jest.fn() } })

      await expect(client.getDisk(ref)).resolves.toEqual({ sizeGb: '200' })
    })

    it('maps transport failures through the shared error mapping', async () => {
      const throttled = GoogleError.parseHttpError({
        error: { code: 429, message: 'rate', status: 'RESOURCE_EXHAUSTED' },
      })
      const get = jest.fn(() => Promise.reject(throttled))
      const client = new GcpDiskClient({ disks: { get, update: jest.fn() } })

      await expect(client.getDisk(ref)).rejects.toThrow(GcpDiskRateLimitedError)
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
