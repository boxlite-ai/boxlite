// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalSessionQuery } from './useTerminalSessionQuery'

const mocks = vi.hoisted(() => ({
  getSignedPortPreviewUrl: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    boxApi: {
      getSignedPortPreviewUrl: mocks.getSignedPortPreviewUrl,
    },
  }),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
  }),
}))

function TerminalSessionProbe({ enabled }: { enabled: boolean }) {
  const { data } = useTerminalSessionQuery('box-1', enabled)
  return <div data-testid="terminal-session-url">{data?.url ?? 'none'}</div>
}

async function flushReactWork() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(0)
    })
  }
}

describe('useTerminalSessionQuery', () => {
  let root: Root | null = null
  let queryClient: QueryClient

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-06T00:00:00.000Z'))
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    })
    mocks.getSignedPortPreviewUrl
      .mockResolvedValueOnce({ data: { url: 'https://terminal.example/session-1' } })
      .mockResolvedValueOnce({ data: { url: 'https://terminal.example/session-2' } })
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    queryClient.clear()
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function renderProbe(enabled: boolean) {
    if (!root) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    }

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <TerminalSessionProbe enabled={enabled} />
        </QueryClientProvider>,
      )
    })
    await flushReactWork()
  }

  it('keeps the active terminal URL stable across rerenders and refreshes it when re-enabled', async () => {
    await renderProbe(true)

    expect(mocks.getSignedPortPreviewUrl).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="terminal-session-url"]')?.textContent).toBe(
      'https://terminal.example/session-1',
    )

    await renderProbe(true)
    await flushReactWork()

    expect(mocks.getSignedPortPreviewUrl).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="terminal-session-url"]')?.textContent).toBe(
      'https://terminal.example/session-1',
    )

    await renderProbe(false)
    await renderProbe(true)
    await flushReactWork()

    expect(mocks.getSignedPortPreviewUrl).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="terminal-session-url"]')?.textContent).toBe(
      'https://terminal.example/session-2',
    )
  })
})
