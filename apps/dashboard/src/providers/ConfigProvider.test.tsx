// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { act, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { ConfigProvider } from './ConfigProvider'

vi.hoisted(() => {
  vi.stubEnv('VITE_BASE_API_URL', '')
  vi.stubEnv('VITE_ENABLE_MOCKING', 'true')
})

it('uses the same-origin API prefix when the preview launcher clears the API URL', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const fetchConfig = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ oidc: { issuer: 'https://auth.example.test', clientId: 'dashboard' } })),
  )
  vi.stubGlobal('fetch', fetchConfig)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Suspense fallback={null}>
            <ConfigProvider>Console</ConfigProvider>
          </Suspense>
        </QueryClientProvider>,
      )
    })

    expect(fetchConfig).toHaveBeenCalledWith(`${window.location.origin}/api/config`)
  } finally {
    act(() => root.unmount())
    client.clear()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})
