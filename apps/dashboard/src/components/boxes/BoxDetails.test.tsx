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
  volumes: [] as { id: string; name: string }[],
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
    authenticatedUserOrganizationMember: { role: 'OWNER' },
    authenticatedUserHasPermission: () => true,
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

vi.mock('@/hooks/queries/useVolumesQuery', () => ({
  useVolumesQuery: () => ({ data: mocks.volumes }),
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
    mocks.volumes = []
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

  // The list page navigates here by id, so the name the user gave the box must
  // survive the transition — the id alone is not how they recognize it.
  it('shows the box name in the identity strip', async () => {
    await renderBoxDetails()

    expect(document.body.textContent).toContain('box-one')
  })

  // A box stores an opaque volume handle, so the mount list is only readable
  // once it is resolved back to the volume's name. The fallback matters just as
  // much: a volume deleted out from under a running box must still render its
  // mount path rather than disappearing from the box's own spec sheet.
  it('resolves mounted volume handles to names, falling back to the raw handle', async () => {
    mocks.volumes = [{ id: 'vol-a1b2c3d4', name: 'subtitle-models' }]
    mocks.box = {
      ...(makeRunningBox() as object),
      volumes: [
        { volumeId: 'vol-a1b2c3d4', mountPath: '/models' },
        { volumeId: 'vol-deleted', mountPath: '/data', subpath: 'acme' },
      ],
    }

    await renderBoxDetails()

    const text = document.body.textContent ?? ''
    expect(text).toContain('subtitle-models')
    expect(text).toContain('/models')
    // Unresolvable handle degrades to the handle itself, not a blank label.
    expect(text).toContain('vol-deleted')
    expect(text).toContain('/data (acme)')
  })
})
