/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { In } from 'typeorm'
import { BoxActivityService } from './box-activity.service'

// The buffer is drained to the database every few seconds, so a read has to
// answer from whichever side holds the box: these cases pin the precedence and
// keep the database out of a read the buffer already answered.
describe('BoxActivityService activity reads', () => {
  const bufferedAt = new Date('2026-08-27T10:00:00.000Z')
  const storedAt = new Date('2026-08-27T09:00:00.000Z')

  let buffer: Map<string, Date>
  let stored: Map<string, Date>
  let findByCalls: unknown[]
  let service: BoxActivityService

  beforeEach(() => {
    buffer = new Map()
    stored = new Map()
    findByCalls = []

    const redis = {
      pipeline: () => {
        const requestedBoxIds: string[] = []
        return {
          zscore: (_key: string, boxId: string) => {
            requestedBoxIds.push(boxId)
          },
          exec: () =>
            Promise.resolve(
              requestedBoxIds.map((boxId) => {
                const at = buffer.get(boxId)
                return [null, at ? String(at.getTime()) : null]
              }),
            ),
        }
      },
    }

    const dataSource = {
      getRepository: () => ({
        findBy: (where: { boxId: unknown }) => {
          findByCalls.push(where.boxId)
          return Promise.resolve([...stored].map(([boxId, lastActivityAt]) => ({ boxId, lastActivityAt })))
        },
      }),
    }

    service = new BoxActivityService(redis as any, dataSource as any, {} as any, {} as any)
  })

  it('prefers the buffered timestamp over the stored one', async () => {
    buffer.set('box-buffered', bufferedAt)
    stored.set('box-buffered', storedAt)

    await expect(service.getLastActivityAt('box-buffered')).resolves.toEqual(bufferedAt)
    expect(findByCalls).toEqual([])
  })

  it('falls back to the stored timestamp when the buffer has no entry', async () => {
    stored.set('box-stored', storedAt)

    await expect(service.getLastActivityAt('box-stored')).resolves.toEqual(storedAt)
    expect(findByCalls).toEqual([In(['box-stored'])])
  })

  it('reports null for a box with no recorded activity', async () => {
    await expect(service.getLastActivityAt('box-idle')).resolves.toBeNull()
  })

  it('merges both sides for many boxes and queries only the unbuffered ones', async () => {
    buffer.set('box-buffered', bufferedAt)
    stored.set('box-stored', storedAt)

    const timestamps = await service.getLastActivityAtMany(['box-buffered', 'box-stored', 'box-idle', 'box-buffered'])

    expect(timestamps.get('box-buffered')).toEqual(bufferedAt)
    expect(timestamps.get('box-stored')).toEqual(storedAt)
    expect(timestamps.has('box-idle')).toBe(false)
    expect(findByCalls).toEqual([In(['box-stored', 'box-idle'])])
  })

  it('touches neither store when asked for no boxes', async () => {
    await expect(service.getLastActivityAtMany([])).resolves.toEqual(new Map())
    expect(findByCalls).toEqual([])
  })
})
