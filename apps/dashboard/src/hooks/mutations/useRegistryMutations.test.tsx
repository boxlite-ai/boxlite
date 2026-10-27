// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys } from '../queries/queryKeys'
import { useCreateRegistryMutation, useDeleteRegistryMutation } from './useRegistryMutations'

const PASSWORD = 'ghp_not-a-real-token'
const credential = { registryHost: 'ghcr.io', username: 'acme-bot', password: PASSWORD }
const api = vi.hoisted(() => ({ createRegistryCredential: vi.fn(), deleteRegistryCredential: vi.fn() }))

vi.mock('../useApi', () => ({
  useApi: () => ({
    registriesApi: api,
  }),
}))

describe('useCreateRegistryMutation', () => {
  beforeEach(() => {
    api.createRegistryCredential.mockResolvedValue({ data: { id: 'credential-1' } })
  })

  it('leaves no copy of the password in the mutation cache once it settles', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const client = new QueryClient()
    let create: ReturnType<typeof useCreateRegistryMutation> | undefined
    const Probe = () => {
      create = useCreateRegistryMutation()
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    )

    await act(async () => {
      await create?.mutateAsync({
        credential: { registryHost: 'ghcr.io', username: 'acme-bot', password: PASSWORD },
        organizationId: 'org-1',
      })
    })
    // The observer still holds the settled mutation until it is reset or
    // unmounted; what gcTime governs is the cache, once nothing observes it.
    act(() => create?.reset())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    const cached = JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    )
    expect(cached).not.toContain(PASSWORD)
    act(() => root.unmount())
  })
})

describe('registry mutations', () => {
  let client: QueryClient
  let root: ReturnType<typeof createRoot>
  let create: ReturnType<typeof useCreateRegistryMutation>
  let remove: ReturnType<typeof useDeleteRegistryMutation>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    api.createRegistryCredential.mockResolvedValue({ data: { id: 'credential-1' } })
    api.deleteRegistryCredential.mockResolvedValue(undefined)
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    client.setQueryData(queryKeys.registries.list('org-1'), [])
    client.setQueryData(queryKeys.registries.list('org-2'), [])
    const Probe = () => {
      create = useCreateRegistryMutation()
      remove = useDeleteRegistryMutation()
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    )
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
  })

  it.each(['create', 'remove'])('%s refreshes only the organization that changed', async (operation) => {
    await act(async () => {
      if (operation === 'create') {
        expect(await create.mutateAsync({ credential, organizationId: 'org-1' })).toEqual({ id: 'credential-1' })
        expect(api.createRegistryCredential).toHaveBeenCalledWith(credential, 'org-1')
      } else {
        await remove.mutateAsync({ id: 'credential-1', organizationId: 'org-1' })
        expect(api.deleteRegistryCredential).toHaveBeenCalledWith('credential-1', 'org-1')
      }
    })
    expect(client.getQueryState(queryKeys.registries.list('org-1'))?.isInvalidated).toBe(true)
    expect(client.getQueryState(queryKeys.registries.list('org-2'))?.isInvalidated).toBe(false)
  })

  it.each(['create', 'remove'])('%s refuses a missing organization before sending a request', async (operation) => {
    await act(async () => {
      const request =
        operation === 'create' ? create.mutateAsync({ credential }) : remove.mutateAsync({ id: 'credential-1' })
      await expect(request).rejects.toThrow('No organization selected')
    })
    expect(api.createRegistryCredential).not.toHaveBeenCalled()
    expect(api.deleteRegistryCredential).not.toHaveBeenCalled()
    expect(client.getQueryState(queryKeys.registries.list('org-1'))?.isInvalidated).toBe(false)
  })

  it.each(['create', 'remove'])('%s preserves the refusal and leaves the list valid', async (operation) => {
    const refusal = new Error('Registry request refused')
    api.createRegistryCredential.mockRejectedValue(refusal)
    api.deleteRegistryCredential.mockRejectedValue(refusal)
    await act(async () => {
      const request =
        operation === 'create'
          ? create.mutateAsync({ credential, organizationId: 'org-1' })
          : remove.mutateAsync({ id: 'credential-1', organizationId: 'org-1' })
      await expect(request).rejects.toBe(refusal)
    })
    expect(client.getQueryState(queryKeys.registries.list('org-1'))?.isInvalidated).toBe(false)
  })
})
