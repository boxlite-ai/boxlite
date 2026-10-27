/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import axios, { AxiosError } from 'axios'
import { describe, expect, it } from 'vitest'
import { ApiClient } from '@/api/apiClient'
import { createBoxFromSnapshot, createSnapshot, listSnapshots } from './cloudSnapshot'
import { snapshotErrorMessage } from './snapshots'

describe('snapshot REST adapter', () => {
  it('reads the v1 envelope and converts timestamp and disk units for display', async () => {
    const api = {
      axiosInstance: axios.create({
        adapter: async (config) => {
          expect(config.url).toBe('v1/org-a/snapshots')
          return {
            config,
            status: 200,
            statusText: 'OK',
            headers: {},
            data: {
              snapshots: [
                {
                  id: 's1',
                  name: 'checkpoint',
                  box_id: 'source',
                  status: 'ready',
                  size_bytes: 2048,
                  container_disk_bytes: 10 * 1024 ** 3,
                  created_at: 1790812800,
                },
              ],
            },
          }
        },
      }),
    } as ApiClient
    expect(await listSnapshots(api, 'org-a')).toEqual([
      {
        id: 's1',
        name: 'checkpoint',
        sourceBoxId: 'source',
        status: 'ready',
        error: undefined,
        sizeBytes: 2048,
        diskGb: 10,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ])
  })

  it('uses the original create routes and retains a nested REST conflict reason', async () => {
    const requests: { url?: string; body: unknown }[] = []
    const api = {
      axiosInstance: axios.create({
        adapter: async (config) => {
          requests.push({ url: config.url, body: JSON.parse(config.data) })
          throw new AxiosError('Request failed with status code 409', undefined, config, undefined, {
            config,
            status: 409,
            statusText: 'Conflict',
            headers: {},
            data: { error: { message: 'Name already exists' } },
          })
        },
      }),
    } as ApiClient
    for (const operation of [
      () => createSnapshot(api, 'org-a', 'source', undefined),
      () => createBoxFromSnapshot(api, 'org-a', 'saved/name', 'worker'),
    ]) {
      const error = await operation().catch((error) => error)
      expect(snapshotErrorMessage(error)).toBe('Name already exists')
    }
    expect(requests).toEqual([
      { url: 'v1/org-a/boxes/source/snapshots', body: {} },
      { url: 'v1/org-a/snapshots/saved%2Fname/boxes', body: { name: 'worker' } },
    ])
  })
})
