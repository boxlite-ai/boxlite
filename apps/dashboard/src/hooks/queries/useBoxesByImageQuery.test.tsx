// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useBoxesByImageQuery } from './useBoxesByImageQuery'

const boxes = vi.hoisted(() => [
  { id: 'b1', name: 'a', image: 'python:3.12', desiredState: 'started' },
  { id: 'b2', name: 'b', image: 'docker.io/library/python:3.13', desiredState: 'stopped' },
  { id: 'b3', name: 'c', image: 'ghcr.io/acme/agent:v1', desiredState: 'started' },
  { id: 'b4', name: 'd', image: 'ghcr.io/acme/agent:v1', desiredState: 'destroyed' },
  { id: 'b5', name: 'e', image: undefined, desiredState: 'started' },
])

vi.mock('../useApi', () => ({
  useApi: () => ({ boxApi: { listBoxesPaginated: async () => ({ data: { items: boxes } }) } }),
}))
vi.mock('../useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))

// Groups a box under the catalog name its reference normalises to, as the API
// does, and leaves out destroyed boxes: those no longer block a removal.
describe('useBoxesByImageQuery', () => {
  it('groups the boxes that still reference each image', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    let result: ReturnType<typeof useBoxesByImageQuery> | undefined
    function Probe() {
      result = useBoxesByImageQuery()
      return null
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe))))
    await vi.waitFor(() => expect(result?.isSuccess).toBe(true))

    expect(result?.byImage.get('docker.io/library/python')?.map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(result?.byImage.get('ghcr.io/acme/agent')?.map((b) => b.id)).toEqual(['b3'])
    expect(result?.byId.get('b4')?.name).toBe('d')
    act(() => root.unmount())
  })
})
