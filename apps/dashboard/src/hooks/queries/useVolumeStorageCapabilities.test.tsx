// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVolumeStorageCapabilities } from './useVolumeStorageCapabilities'

const state = vi.hoisted(() => ({ organization: { id: 'org-1' } as { id: string } | null }))
const getVolumeStorageCapabilities = vi.hoisted(() => vi.fn())
vi.mock('../useApi', () => ({ useApi: () => ({ getVolumeStorageCapabilities }) }))
vi.mock('../useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: state.organization }),
}))

describe('useVolumeStorageCapabilities', () => {
  let client: QueryClient
  let root: ReturnType<typeof createRoot>
  let query: ReturnType<typeof useVolumeStorageCapabilities>

  function Probe() {
    query = useVolumeStorageCapabilities()
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
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.organization = { id: 'org-1' }
    getVolumeStorageCapabilities.mockReset()
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    root = createRoot(document.createElement('div'))
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
  })

  it('loads capabilities and isolates them by selected organization', async () => {
    const standardOnly = { object_storage_enabled: true, filestore_enabled: false }
    const filestoreEnabled = { object_storage_enabled: true, filestore_enabled: true }
    getVolumeStorageCapabilities.mockResolvedValueOnce(standardOnly).mockResolvedValueOnce(filestoreEnabled)

    await render()
    await act(async () => {
      await vi.waitFor(() => expect(query.isSuccess).toBe(true))
    })
    expect(query.data).toEqual(standardOnly)

    state.organization = { id: 'org-2' }
    await render()
    await act(async () => {
      await vi.waitFor(() => expect(query.data).toEqual(filestoreEnabled))
    })

    expect(getVolumeStorageCapabilities).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(['volume-storage-capabilities', 'org-1'])).toEqual(standardOnly)
    expect(client.getQueryData(['volume-storage-capabilities', 'org-2'])).toEqual(filestoreEnabled)
  })

  it('does not request capabilities without a selected organization', async () => {
    state.organization = null
    await render()

    expect(query.fetchStatus).toBe('idle')
    expect(query.data).toBeUndefined()
    expect(getVolumeStorageCapabilities).not.toHaveBeenCalled()
  })
})
