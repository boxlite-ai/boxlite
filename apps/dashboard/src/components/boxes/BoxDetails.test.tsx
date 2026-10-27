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
  images: [] as { id: string | null; name: string; curated: boolean; curatedRef: string | null }[],
  boxRefetch: vi.fn(),
  terminalMounts: vi.fn(),
  navigate: vi.fn(),
  setSearchParams: vi.fn(),
  mutateAsync: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) => (
    <a href={to} className={className}>
      {children as never}
    </a>
  ),
  generatePath: (path: string, params: Record<string, string>) =>
    path.replace(/:(\w+)/g, (_match, key: string) => params[key] ?? ''),
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

// Owns its own mutations and needs an ApiProvider; these tests cover the detail
// shell, and the network panel has its own stories.
vi.mock('./BoxNetworkSection', () => ({
  BoxNetworkSection: () => null,
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

vi.mock('@/hooks/queries/useImagesQuery', () => ({
  useImagesQuery: () => ({ data: mocks.images }),
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

vi.mock('./BoxTerminal', async () => {
  const { useEffect } = await import('react')
  return {
    BoxTerminal: ({ boxId }: { boxId: string }) => {
      useEffect(() => mocks.terminalMounts(), [])
      return <div data-testid="terminal">{boxId}</div>
    },
  }
})

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
    mocks.images = []
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

    expect(mocks.terminalMounts).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-testid="terminal"]')).not.toBeNull()

    const refreshButton = document.querySelector<HTMLButtonElement>('button[title="refresh"]')
    expect(refreshButton).not.toBeNull()

    await act(async () => {
      refreshButton?.click()
    })
    await flushReactWork()

    expect(mocks.boxRefetch).toHaveBeenCalledTimes(1)
    // A fresh mount is a fresh shell: the refresh reconnects.
    expect(mocks.terminalMounts).toHaveBeenCalledTimes(2)
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
  // A box stores the reference it was created with. Once a start has put that
  // image in the catalog, the reference is how a reader gets to its versions.
  it('links the image to its catalog entry once the catalog has it', async () => {
    mocks.images = [{ id: 'img-agent', name: 'ghcr.io/acme/agent', curated: false, curatedRef: null }]
    mocks.box = { ...(makeRunningBox() as object), image: 'ghcr.io/acme/agent:1.0' }

    await renderBoxDetails()

    const link = [...document.querySelectorAll('a')].find((a) => a.textContent === 'ghcr.io/acme/agent:1.0')
    expect(link?.getAttribute('href')).toBe('/dashboard/images/img-agent')
  })

  // The API's reason for a private pull no credential covers names the fix;
  // the page carries the way to it, with the registry already chosen.
  it('offers to connect the registry a private pull was refused by', async () => {
    mocks.box = {
      ...(makeRunningBox() as object),
      state: BoxState.ERROR,
      image: 'quay.io/acme/tools:2',
      errorReason:
        "Failed to pull image 'quay.io/acme/tools:2': quay.io refused the pull (UNAUTHORIZED). The image is private or does not exist, and no registry login of the organization covers it.",
    }

    await renderBoxDetails()

    const link = [...document.querySelectorAll('a')].find((a) => a.textContent?.includes('Connect a registry'))
    expect(link?.getAttribute('href')).toBe('/dashboard/images/registries?connect=quay.io')
  })

  it('offers no registry for an error that is not a refused private pull', async () => {
    mocks.box = { ...(makeRunningBox() as object), state: BoxState.ERROR, errorReason: 'Out of capacity' }

    await renderBoxDetails()

    expect(document.body.textContent).not.toContain('Connect a registry')
  })
})
