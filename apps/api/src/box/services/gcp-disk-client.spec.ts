/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

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
      // provisioned IOPS/throughput to defaults.
      expect(disks.update).toHaveBeenCalledWith({
        project: 'proj',
        zone: 'z1',
        disk: 'disk-1',
        diskResource: { sizeGb: '4096' },
        paths: ['sizeGb'],
      })
    })

    it.each([
      ['a GCP 400', { code: 400, message: 'rate limit exceeded' }, true],
      ['a transport 5xx', { code: 500, message: 'backend error' }, false],
      ['a 404 for a replaced disk', { code: 404, message: 'not found' }, false],
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
    it('labels 400s as rate limited and passes everything else through', () => {
      expect(toExpansionClientError({ code: 400, message: 'no' })).toBeInstanceOf(GcpDiskRateLimitedError)
      const other = toExpansionClientError(new Error('boom'))
      expect(other).toBeInstanceOf(Error)
      expect(other).not.toBeInstanceOf(GcpDiskRateLimitedError)
      expect(other.message).toBe('boom')
    })
  })
})
