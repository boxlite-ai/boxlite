// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { useCreateRegistryMutation } from './useRegistryMutations'

const PASSWORD = 'ghp_not-a-real-token'

vi.mock('../useApi', () => ({
  useApi: () => ({
    registriesApi: {
      createRegistryCredential: vi.fn(async () => ({ data: { id: 'credential-1' } })),
    },
  }),
}))

describe('useCreateRegistryMutation', () => {
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
