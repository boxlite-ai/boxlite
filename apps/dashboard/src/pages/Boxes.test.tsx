// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Boxes from './Boxes'

const navigate = vi.hoisted(() => vi.fn())
// Each test decides what the account holds.
const state = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>> | undefined,
  total: 0,
  // The first render, before the list query has answered.
  pending: false,
  // The two account-state queries do not resolve together.
  boxCountPending: false,
}))

// Stand-ins for the two dialogs, so the assertions can read what the page
// decided about them rather than reaching into a real dialog's internals.
vi.mock('@/components/OnboardingGuideDialog', () => ({
  OnboardingGuideDialog: ({ open }: { open?: boolean }) => (
    <div data-testid="onboarding-dialog" data-open={String(!!open)} />
  ),
}))
vi.mock('@/components/Box/CreateBoxDialog', () => ({
  CreateBoxDialog: () => <div data-testid="create-box-dialog" />,
}))

// Row actions live behind a Radix dropdown. Render its items inline so a test
// can reach them, the same way BoxTable's own test flattens the page-size
// Select.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuGroup: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuPortal: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: Passthrough,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuCheckboxItem: Passthrough,
    DropdownMenuRadioGroup: Passthrough,
    DropdownMenuRadioItem: Passthrough,
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  }
})

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserHasPermission: () => true,
  }),
}))
vi.mock('@/hooks/useBoxes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useBoxes')>()),
  useBoxes: () => ({
    data: state.pending ? undefined : { items: state.items, total: state.total, totalPages: 1 },
    isLoading: false,
    isPlaceholderData: false,
    error: undefined,
  }),
}))
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ boxApi: { listBoxesPaginated: vi.fn().mockResolvedValue({ data: { total: 0 } }) } }),
}))
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: 'https://api.example.test', oidc: { issuer: '' } }),
}))
vi.mock('@/hooks/useNotificationSocket', () => ({ useNotificationSocket: () => ({ notificationSocket: null }) }))
vi.mock('@/hooks/queries/useApiKeysQuery', () => ({
  useApiKeysQuery: () => ({
    data: state.pending ? undefined : [],
    isLoading: state.pending,
    isSuccess: !state.pending,
  }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: state.pending || state.boxCountPending ? undefined : 0,
    isSuccess: !state.pending && !state.boxCountPending,
  }),
  useQueryClient: () => ({ setQueriesData: vi.fn(), invalidateQueries: vi.fn(), cancelQueries: vi.fn() }),
}))
// `sub` matters: Boxes keys its onboarding-skip flag on it and bails out of the
// auto-open effect entirely without one.
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { sub: 'user-1', email: 'user@example.test' } } }),
}))
vi.mock('react-router-dom', () => ({
  generatePath: (path: string) => path,
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }))

function buttonWith(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  )
}

/** The element a test is about; failing here beats a null-dereference later. */
function required<T extends Element>(element: T | null | undefined, what: string): T {
  if (!element) {
    throw new Error(`Missing expected element: ${what}`)
  }
  return element
}

function onboardingIsOpen() {
  return document.querySelector('[data-testid="onboarding-dialog"]')?.getAttribute('data-open')
}

describe('Boxes page, empty account', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = () =>
      ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList
  })

  beforeEach(() => {
    state.items = []
    state.total = 0
    state.pending = false
    state.boxCountPending = false
    // Most cases are about the empty state itself, so start from a browser that
    // has already dismissed the guide; auto-open has its own case below.
    localStorage.setItem('SkipOnboarding_user-1', 'true')
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    localStorage.clear()
    vi.clearAllMocks()
  })

  function render() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(<Boxes />)
    })
  }

  it('keeps the page and leads with the table empty state', () => {
    render()

    // The page is still a Boxes page: its own heading and its create dialog
    // survive an empty account, rather than being replaced by a panel.
    expect(document.body.textContent).toContain('No boxes yet.')
    expect(document.querySelector('h1')?.textContent).toBe('Boxes')
    // The create affordance still belongs to the page, not to the empty state.
    expect(document.querySelector('[data-testid="create-box-dialog"]')).not.toBeNull()
    expect(onboardingIsOpen()).toBe('false')
  })

  it('opens the guide from the empty state, rather than inlining a second copy', () => {
    render()

    const openQuickstart = required(buttonWith('Open Quickstart'), 'Open Quickstart button')

    act(() => openQuickstart.click())

    expect(onboardingIsOpen()).toBe('true')
  })

  it('navigates to a box when its row is clicked, and arms delete from the row menu', () => {
    state.items = [
      {
        id: 'box-1',
        name: 'web-api',
        state: 'started',
        cpu: 1,
        memory: 1,
        disk: 10,
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]
    state.total = 1
    render()

    const row = required(document.querySelector<HTMLElement>('div.cursor-pointer'), 'box row')
    act(() => row.click())
    expect(navigate).toHaveBeenCalled()

    const deleteItem = required(buttonWith('Delete'), 'row menu Delete')
    act(() => deleteItem.click())

    // The page owns the confirmation, so arming it from a row must open the
    // page's dialog rather than deleting outright.
    expect(document.body.textContent).toContain('Confirm Box Deletion')
  })

  it('renders an empty table rather than guessing while the list is still loading', () => {
    state.pending = true
    render()

    // Nothing is known yet, so every count falls back rather than reading as a
    // real zero from the server, and the page still stands up.
    expect(document.querySelector('h1')?.textContent).toBe('Boxes')
    expect(onboardingIsOpen()).toBe('false')
  })

  it('waits for both account-state queries before deciding to auto-open the guide', () => {
    // API keys have answered; the box count has not. Account state is not known
    // yet, so the guide must not auto-open on half the picture.
    state.boxCountPending = true
    render()

    expect(onboardingIsOpen()).toBe('false')
  })

  it('opens the guide by itself for an account with no keys and no boxes', () => {
    // Nothing dismissed anywhere, and both account signals say the account is
    // empty: this is someone's first visit, so the guide leads.
    localStorage.clear()
    render()

    expect(onboardingIsOpen()).toBe('true')
  })
})
