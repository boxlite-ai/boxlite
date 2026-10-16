// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRegistriesQuery } from './useRegistriesQuery'

const state = vi.hoisted(() => ({ organization: { id: 'org-1' } as { id: string } | null }))
const listRegistryCredentials = vi.hoisted(() => vi.fn())
vi.mock('../useApi', () => ({ useApi: () => ({ registriesApi: { listRegistryCredentials } }) }))
vi.mock('../useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: state.organization }),
}))

describe('registry queries', () => {
  let client: QueryClient
  let root: ReturnType<typeof createRoot>
  let host: HTMLDivElement
  let query: ReturnType<typeof useRegistriesQuery>

  function Probe() {
    query = useRegistriesQuery()
    return <div>{query.error?.message ?? query.data?.map((credential) => credential.username).join(',') ?? 'none'}</div>
  }

  async function render() {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    )
    await act(async () => {
      await vi.waitFor(() => expect(client.isFetching()).toBe(0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.organization = { id: 'org-1' }
    listRegistryCredentials.mockReset().mockResolvedValue({ data: [{ id: 'credential-1', username: 'acme-bot' }] })
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    host = document.createElement('div')
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
  })

  it('reads the selected organization and isolates its cached logins when switching', async () => {
    await render()
    expect(listRegistryCredentials).toHaveBeenCalledWith('org-1')
    expect(host.textContent).toBe('acme-bot')

    state.organization = { id: 'org-2' }
    listRegistryCredentials.mockResolvedValue({ data: [{ id: 'credential-2', username: 'other-bot' }] })
    await render()
    expect(listRegistryCredentials).toHaveBeenLastCalledWith('org-2')
    expect(host.textContent).toBe('other-bot')
  })

  it('sends nothing without an organization, including a forced refetch', async () => {
    state.organization = null
    await render()
    expect(listRegistryCredentials).not.toHaveBeenCalled()
    await act(async () => {
      expect((await query.refetch()).error?.message).toBe('No organization selected')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(listRegistryCredentials).not.toHaveBeenCalled()
    expect(host.textContent).toBe('No organization selected')
  })

  it('exposes a failed list instead of treating it as an empty success', async () => {
    const refusal = new Error('Forbidden')
    listRegistryCredentials.mockRejectedValue(refusal)
    await render()
    expect(query.error).toBe(refusal)
    expect(query.data).toBeUndefined()
  })
})
