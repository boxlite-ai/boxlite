// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Box, BoxState } from '@boxlite-ai/api-client'
import BoxDetails from './BoxDetails'

const mocks = vi.hoisted(() => ({
  box: undefined as unknown,
  boxRefetch: vi.fn(),
  terminalRefetch: vi.fn(),
  terminalReset: vi.fn(),
  navigate: vi.fn(),
  setSearchParams: vi.fn(),
  mutateAsync: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ boxId: 'box-1' }),
  useSearchParams: () => [new URLSearchParams(), mocks.setSearchParams],
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { sub: 'user-1' } } }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
  },
}))

vi.mock('@/components/OnboardingGuideDialog', () => ({
  OnboardingGuideDialog: () => null,
}))

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({}),
}))

vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({
    getRegionName: (target?: string) => target,
  }),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserOrganizationMember: { role: 'owner' },
    authenticatedUserHasPermission: () => true,
  }),
}))

vi.mock('@/hooks/queries/useBillingPricingQuery', () => ({
  useBillingPricingQuery: () => ({
    data: {
      version: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      cpuRateCentsPerHour: '5.04',
      memRateCentsPerHour: '1.62',
      diskRateCentsPerHour: '0.0108',
      gpuRateCentsPerHour: '0',
    },
  }),
}))

vi.mock('@/hooks/queries/useBoxBillingUsageQuery', () => ({
  useBoxBillingUsageQuery: () => ({
    data: { costPreciseCents: '2.778' },
  }),
}))

vi.mock('@/hooks/useBoxWsSync', () => ({
  useBoxWsSync: () => undefined,
}))

vi.mock('@/hooks/useBoxSessionContext', () => ({
  useBoxSessionContext: () => ({
    isTerminalActivated: () => true,
    activateTerminal: vi.fn(),
  }),
}))

vi.mock('@/hooks/queries/useBoxQuery', () => ({
  useBoxQuery: () => ({
    data: mocks.box,
    isLoading: false,
    isError: false,
    error: null,
    refetch: mocks.boxRefetch,
  }),
}))

vi.mock('@/hooks/queries/useTerminalSessionQuery', () => ({
  useTerminalSessionQuery: () => ({
    data: { url: 'https://terminal.example/session-1', expiresAt: Date.now() + 300000 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.terminalRefetch,
    reset: mocks.terminalReset,
  }),
}))

vi.mock('@/hooks/mutations/useStartBoxMutation', () => ({
  useStartBoxMutation: () => ({ isPending: false, mutateAsync: mocks.mutateAsync }),
}))

vi.mock('@/hooks/mutations/useStopBoxMutation', () => ({
  useStopBoxMutation: () => ({ isPending: false, mutateAsync: mocks.mutateAsync }),
}))

vi.mock('@/hooks/mutations/useRecoverBoxMutation', () => ({
  useRecoverBoxMutation: () => ({ isPending: false, mutateAsync: mocks.mutateAsync }),
}))

vi.mock('@/hooks/mutations/useDeleteBoxMutation', () => ({
  useDeleteBoxMutation: () => ({ isPending: false, mutateAsync: mocks.mutateAsync }),
}))

vi.mock('./BoxTerminalFrame', () => ({
  BoxTerminalFrame: ({ sessionUrl }: { sessionUrl: string }) => <div data-testid="terminal-frame">{sessionUrl}</div>,
}))

function makeRunningBox(): Box {
  return {
    id: 'box-1',
    name: 'box-one',
    state: BoxState.STARTED,
    cpu: 1,
    memory: 2,
    disk: 10,
    image: 'ubuntu:24.04',
    target: 'us-east-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:01:00.000Z',
  } as Box
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('BoxDetails refresh', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    mocks.box = makeRunningBox()
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderBoxDetails() {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<BoxDetails />)
    })

    await flushReactWork()
  }

  it('reconnects an active terminal when the detail refresh button is clicked', async () => {
    await renderBoxDetails()

    expect(mocks.terminalRefetch).not.toHaveBeenCalled()
    const frameBeforeRefresh = document.querySelector('[data-testid="terminal-frame"]')
    expect(frameBeforeRefresh).not.toBeNull()

    const refreshButton = document.querySelector<HTMLButtonElement>('button[title="refresh"]')
    expect(refreshButton).not.toBeNull()

    await act(async () => {
      refreshButton?.click()
    })
    await flushReactWork()

    expect(mocks.boxRefetch).toHaveBeenCalledTimes(1)
    expect(mocks.terminalRefetch).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="terminal-frame"]')).toBe(frameBeforeRefresh)
  })

  it('shows the current running rate and this box rated cost', async () => {
    await renderBoxDetails()

    expect(document.body.textContent).toContain('cost')
    expect(document.body.textContent).toContain('$0.08388 / hr')
    expect(document.body.textContent).toContain('$0.0278')
    expect(document.body.textContent).toContain('pricing v1')
  })
})
