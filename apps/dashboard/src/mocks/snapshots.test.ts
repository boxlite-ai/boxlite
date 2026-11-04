/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */
import { setupServer } from 'msw/node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { snapshotHandlers } from './snapshots'
import { MOCK_BOXES, MOCK_PAGINATED_BOXES } from './fixtures'

const base = 'http://snapshot-mock.test'
const route = `${base}/v1/org/snapshots/snapshot-before-deploy`
const server = setupServer()
let originals: typeof MOCK_BOXES
beforeEach(() => {
  originals = structuredClone(MOCK_BOXES)
  vi.useFakeTimers()
  server.use(...snapshotHandlers(base))
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.close()
  server.resetHandlers()
  vi.useRealTimers()
  MOCK_BOXES.splice(0, MOCK_BOXES.length, ...originals)
  MOCK_PAGINATED_BOXES.total = MOCK_BOXES.length
})
async function create(name: string) {
  const response = await fetch(`${route}/boxes`, { method: 'POST', body: JSON.stringify({ name }) })
  expect(response.status).toBe(201)
  return (await response.json()).box_id as string
}

it('gives snapshot children independent network policy objects', async () => {
  const source = MOCK_BOXES[0]
  const id = await create('child-network')
  const child = MOCK_BOXES.find((box) => box.id === id)!
  expect(child.network).not.toBe(source.network)
  expect(child.network?.inbound).not.toBe(source.network?.inbound)
  expect(child.network?.outbound).not.toBe(source.network?.outbound)
  expect(child.network).toEqual(source.network)
})

it('keeps a snapshot pinned until all children finish initializing', async () => {
  await create('first-child')
  await vi.advanceTimersByTimeAsync(2000)
  await create('second-child')
  await vi.advanceTimersByTimeAsync(4500)
  expect((await fetch(route, { method: 'DELETE' })).status).toBe(409)
  await vi.advanceTimersByTimeAsync(2000)
  expect((await fetch(route, { method: 'DELETE' })).status).toBe(204)
})
