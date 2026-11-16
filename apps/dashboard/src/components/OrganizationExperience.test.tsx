// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrganizationGate, OrganizationSwitcher } from './OrganizationExperience'
import { ORGANIZATION_SESSION_KEY, readOrganizationSession, saveOrganizationSession } from '@/lib/organization-session'
import { markJustLoggedOut } from '@/lib/auth-session'

const mocks = vi.hoisted(() => ({
  organizations: [
    { id: 'a', name: 'Same name' },
    { id: 'b', name: 'Same name' },
  ],
  user: { profile: { sub: 'user-a', email: 'a@example.com' } },
  members: vi.fn(),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: mocks.organizations[0] }),
}))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => ({ organizations: mocks.organizations }) }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: mocks.user }) }))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ organizationsApi: { listOrganizationMembers: mocks.members } }) }))

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  sessionStorage.clear()
  mocks.organizations = [
    { id: 'a', name: 'Same name' },
    { id: 'b', name: 'Same name' },
  ]
  mocks.members.mockReset().mockResolvedValue({ data: [{ userId: 'user-a' }] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(path = '/dashboard/boxes') {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <OrganizationGate>
          <h2>Business page</h2>
        </OrganizationGate>
      </MemoryRouter>,
    ),
  )
}
async function choose() {
  await act(async () => host.querySelector<HTMLButtonElement>('main button')!.click())
}
function mockDocumentNavigation() {
  const navigation = { assign: vi.fn(), reload: vi.fn() }
  vi.stubGlobal(
    'window',
    new Proxy(window, {
      get(target, key) {
        return key === 'location' ? navigation : Reflect.get(target, key, target)
      },
    }),
  )
  return navigation
}
describe('Organization experience', () => {
  it('blocks multi-org business content until explicit membership-validated selection', async () => {
    await render()
    expect(host.textContent).not.toContain('Business page')
    expect(host.textContent).toContain('Same namea')
    expect(host.textContent).toContain('Same nameb')
    await choose()
    expect(mocks.members).toHaveBeenCalledExactlyOnceWith('a')
    expect(readOrganizationSession('user-a')).toBe('a')
    expect(host.textContent).toContain('Business page')
  })
  it('restores only this user’s valid selection', async () => {
    saveOrganizationSession('user-a', 'b')
    await render()
    expect(host.textContent).toContain('Business page')
    expect(readOrganizationSession('user-b')).toBeNull()
  })
  it.each(['other-user', 'removed-org'])('requires selection for %s records', async (scenario) => {
    saveOrganizationSession(
      scenario === 'other-user' ? 'user-b' : 'user-a',
      scenario === 'removed-org' ? 'deleted' : 'a',
    )
    await render()
    expect(host.textContent).toContain('Choose an organization')
  })
  it('skips selection for one organization', async () => {
    mocks.organizations = mocks.organizations.slice(0, 1)
    await render()
    expect(host.textContent).toBe('Business page')
    expect(mocks.members).not.toHaveBeenCalled()
  })
  it('shows recovery for zero organizations', async () => {
    mocks.organizations = []
    await render()
    expect(host.textContent).toContain('No organizations yet')
    expect(host.textContent).toContain('Refresh')
    expect(host.textContent).not.toContain('Business page')
  })
  it.each(['/dashboard/user/invitations?id=invite', '/dashboard/organization/a/verify-email/a/token'])(
    'allows the scoped entry %s',
    async (path) => {
      await render(path)
      expect(host.textContent).toBe('Business page')
    },
  )
  it.each(['denied', 'network', 'storage'])(
    'keeps the chooser and record unchanged after %s failure',
    async (failure) => {
      if (failure === 'denied') mocks.members.mockResolvedValue({ data: [] })
      if (failure === 'network') mocks.members.mockRejectedValue(new Error('offline'))
      if (failure === 'storage')
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new Error('denied')
        })
      await render()
      await choose()
      expect(host.querySelector('[role="alert"]')).not.toBeNull()
      expect(readOrganizationSession('user-a')).toBeNull()
      expect(host.textContent).not.toContain('Business page')
    },
  )
  it('prevents duplicate submissions while pending', async () => {
    let resolve!: (value: unknown) => void
    mocks.members.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    await render()
    await choose()
    await choose()
    expect(mocks.members).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ data: [{ userId: 'user-a' }] }))
    expect(host.textContent).toContain('Business page')
  })
  it('searches more than five organizations by ID and reports no matches', async () => {
    mocks.organizations = Array.from({ length: 6 }, (_, i) => ({ id: `org-${i}`, name: 'Same name' }))
    await render()
    const input = host.querySelector<HTMLInputElement>('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'org-4')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.textContent).toContain('org-4')
    expect(host.textContent).not.toContain('org-0')
    await act(async () => {
      setValue.call(input, 'missing')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.textContent).toContain('No organizations match')
  })
  it('moves keyboard focus through organization choices', async () => {
    await render()
    const buttons = host.querySelectorAll<HTMLButtonElement>('main button')
    buttons[0].focus()
    await act(async () => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(buttons[1])
  })
  it('keeps the current organization selected without another request', async () => {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <OrganizationSwitcher />
        </MemoryRouter>,
      ),
    )
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-current="true"]')!.click())
    expect(mocks.members).not.toHaveBeenCalled()
  })
  it('cancels a switch from a terminal without touching membership or session', async () => {
    saveOrganizationSession('user-a', 'a')
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes/box-a/terminal']}>
          <OrganizationSwitcher />
        </MemoryRouter>,
      ),
    )
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    const choices = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
    await act(async () => choices[1].click())
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Stay here',
    )!
    await act(async () => cancel.click())
    expect(mocks.members).not.toHaveBeenCalled()
    expect(readOrganizationSession('user-a')).toBe('a')
  })
  it('keeps the current session when a confirmed terminal switch is denied', async () => {
    saveOrganizationSession('user-a', 'a')
    mocks.members.mockResolvedValue({ data: [] })
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes/box-a/terminal']}>
          <OrganizationSwitcher />
        </MemoryRouter>,
      ),
    )
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')[1].click())
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Switch organization',
    )!
    await act(async () => confirm.click())
    expect(mocks.members).toHaveBeenCalledExactlyOnceWith('b')
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(readOrganizationSession('user-a')).toBe('a')
  })
  it('does not commit an in-flight selection after the chooser is unmounted', async () => {
    let resolve!: (value: unknown) => void
    mocks.members.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    await render()
    await choose()
    await act(async () => root.render(null))
    await act(async () => resolve({ data: [{ userId: 'user-a' }] }))
    expect(readOrganizationSession('user-a')).toBeNull()
  })
  it('preserves the requested deep link when selecting an organization at login', async () => {
    function Destination() {
      const location = useLocation()
      return <output>{location.pathname + location.search + location.hash}</output>
    }
    const path = '/dashboard/boxes/box-a/terminal?view=logs#output'
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <OrganizationGate>
            <Destination />
          </OrganizationGate>
        </MemoryRouter>,
      ),
    )
    expect(host.querySelector('output')).toBeNull()
    await choose()
    expect(host.querySelector('output')?.textContent).toBe(path)
    expect(readOrganizationSession('user-a')).toBe('a')
  })
  it('commits the target session before full document navigation', async () => {
    saveOrganizationSession('user-a', 'a')
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes?filter=old']}>
          <OrganizationSwitcher />
        </MemoryRouter>,
      ),
    )
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    const navigation = mockDocumentNavigation()
    navigation.assign.mockImplementation(() => expect(readOrganizationSession('user-a')).toBe('b'))
    await act(async () => document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')[1].click())
    expect(navigation.assign).toHaveBeenCalledExactlyOnceWith('/dashboard/boxes')
  })
  it('offers document reload and logout recovery with zero organizations', async () => {
    mocks.organizations = []
    await render()
    const navigation = mockDocumentNavigation()
    const buttons = host.querySelectorAll<HTMLButtonElement>('main button')
    await act(async () => buttons[0].click())
    expect(navigation.reload).toHaveBeenCalledTimes(1)
    await act(async () => buttons[1].click())
    expect(navigation.assign).toHaveBeenCalledWith('/logout')
  })
  it('clears confirmation on explicit logout', () => {
    saveOrganizationSession('user-a', 'a')
    markJustLoggedOut()
    expect(readOrganizationSession('user-a')).toBeNull()
  })
  it('recovers from malformed storage', async () => {
    sessionStorage.setItem(ORGANIZATION_SESSION_KEY, '{')
    await render()
    expect(host.textContent).toContain('Choose an organization')
  })
})
