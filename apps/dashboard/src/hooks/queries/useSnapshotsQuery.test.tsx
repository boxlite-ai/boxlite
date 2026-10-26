// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { BoxliteError } from '@/api/errors'
import { useCreateSnapshotMutation } from '../mutations/useCreateSnapshotMutation'
import { useDeleteSnapshotMutation } from '../mutations/useDeleteSnapshotMutation'
import { useCreateBoxFromSnapshotMutation } from '../mutations/useCreateBoxFromSnapshotMutation'
import { useSnapshotsQuery } from './useSnapshotsQuery'
import { useSnapshotBoxesQuery } from './useSnapshotBoxesQuery'
import { queryKeys } from './queryKeys'

const state = vi.hoisted(() => ({ orgId: 'org-a' as string | undefined }))
const api = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  createSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  createBoxFromSnapshot: vi.fn(),
  listBoxesPaginated: vi.fn(),
}))
vi.mock('../useApi', () => ({ useApi: () => ({ boxApi: api }) }))
vi.mock('@/lib/cloudSnapshot', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock('../useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: state.orgId ? { id: state.orgId } : undefined,
  }),
}))

const snapshot = {
  id: 's-1',
  name: 'checkpoint',
  sourceBoxId: 'b-1',
  status: 'creating',
  diskGb: 10,
  sizeBytes: 0,
  createdAt: '2026-10-01T00:00:00Z',
}

describe('snapshot queries and mutations', () => {
  let client: QueryClient
  let root: Root
  let result: {
    snapshots: ReturnType<typeof useSnapshotsQuery>
    boxes: ReturnType<typeof useSnapshotBoxesQuery>
    create: ReturnType<typeof useCreateSnapshotMutation>
    remove: ReturnType<typeof useDeleteSnapshotMutation>
    createBox: ReturnType<typeof useCreateBoxFromSnapshotMutation>
  }
  function Probe() {
    result = {
      snapshots: useSnapshotsQuery(),
      boxes: useSnapshotBoxesQuery(),
      create: useCreateSnapshotMutation(),
      remove: useDeleteSnapshotMutation(),
      createBox: useCreateBoxFromSnapshotMutation(),
    }
    return null
  }
  async function render() {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    )
    await tick(1)
  }
  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.resetAllMocks()
    state.orgId = 'org-a'
    api.listSnapshots.mockResolvedValue([])
    api.listBoxesPaginated.mockResolvedValue({ data: { items: [], totalPages: 1 } })
    api.createSnapshot.mockResolvedValue(snapshot)
    api.createBoxFromSnapshot.mockResolvedValue({ box_id: 'new-box' })
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    vi.useRealTimers()
  })

  it('polls creating snapshots every five seconds and stops when ready', async () => {
    api.listSnapshots.mockResolvedValueOnce([snapshot]).mockResolvedValue([{ ...snapshot, status: 'ready' }])
    await render()
    expect(result.snapshots.data?.[0].status).toBe('creating')
    await tick(5000)
    expect(result.snapshots.data?.[0].status).toBe('ready')
    expect(api.listSnapshots).toHaveBeenCalledTimes(2)
    await tick(15000)
    expect(api.listSnapshots).toHaveBeenCalledTimes(2)
  })

  it('does not retry or keep polling a disabled environment', async () => {
    const cause = new AxiosError('Unavailable', undefined, undefined, undefined, { status: 503 } as never)
    api.listSnapshots.mockRejectedValue(new BoxliteError('Disabled', { cause }))
    await render()
    await tick(30000)
    expect(result.snapshots.isError).toBe(true)
    expect(api.listSnapshots).toHaveBeenCalledTimes(1)
  })

  it('loads every page of boxes so later-page sources are not reported deleted', async () => {
    api.listBoxesPaginated.mockImplementation(async (_org, page) => ({
      data: { items: [{ id: `box-${page}` }], totalPages: 3 },
    }))
    await render()
    expect(result.boxes.data?.map((box) => box.id)).toEqual(['box-1', 'box-2', 'box-3'])
    expect(api.listBoxesPaginated).toHaveBeenNthCalledWith(3, 'org-a', 3, 100)
  })

  it.each(['create', 'remove'] as const)('%s refreshes only the affected organization', async (operation) => {
    await render()
    client.setQueryData(queryKeys.snapshots.list('org-b'), [{ ...snapshot, id: 'other' }])
    await act(async () => {
      if (operation === 'create')
        await result.create.mutateAsync({ boxId: 'b-1', name: 'checkpoint', organizationId: 'org-a' })
      else await result.remove.mutateAsync({ snapshotId: 's-1', organizationId: 'org-a' })
    })
    expect(api.listSnapshots.mock.calls.every(([, org]) => org === 'org-a')).toBe(true)
    expect(client.getQueryState(queryKeys.snapshots.list('org-b'))?.isInvalidated).toBe(false)
    if (operation === 'create')
      expect(api.createSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 'b-1', 'checkpoint')
    else expect(api.deleteSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 's-1')
  })

  it('refuses requests without an organization', async () => {
    state.orgId = undefined
    await render()
    await act(async () => {
      await expect(result.create.mutateAsync({ boxId: 'b-1', name: 'x' })).rejects.toThrow('No organization selected')
      await expect(result.remove.mutateAsync({ snapshotId: 's-1' })).rejects.toThrow('No organization selected')
    })
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled()
  })

  it('keeps snapshot lists isolated when the organization changes', async () => {
    api.listSnapshots.mockResolvedValue([snapshot])
    await render()
    state.orgId = 'org-b'
    api.listSnapshots.mockResolvedValue([])
    await render()
    expect(api.listSnapshots).toHaveBeenLastCalledWith(expect.anything(), 'org-b')
    expect(result.snapshots.data).toEqual([])
    expect(client.getQueryData(queryKeys.snapshots.list('org-a'))).toEqual([snapshot])
  })

  it('creating a box invalidates only the selected organization boxes', async () => {
    await render()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await act(async () => {
      await result.createBox.mutateAsync({ snapshotId: 's-1', name: '', organizationId: 'org-a' })
    })
    expect(api.createBoxFromSnapshot).toHaveBeenCalledWith(expect.anything(), 'org-a', 's-1', undefined)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['boxes', 'org-a'] })
  })
})
