// @vitest-environment jsdom
import { act, StrictMode, useContext, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrganizationsContext } from '@/contexts/OrganizationsContext'
import { registrationSession } from '@/lib/referral-session'
import { OrganizationsProvider } from './OrganizationsProvider'

const fixture = vi.hoisted(() => ({
  api: { listOrganizations: vi.fn() },
  auth: { user: { profile: { sub: 'user-1' } }, signinRedirect: vi.fn() },
  entered: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ organizationsApi: fixture.api }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ oidc: { issuer: 'https://issuer.test' } }) }))
vi.mock('react-oidc-context', () => ({ useAuth: () => fixture.auth }))
function Consumer() {
  const context = useContext(OrganizationsContext)!
  useEffect(() => {
    fixture.entered()
  }, [])
  return (
    <>
      <span>{context.organizations.map((org) => org.name).join(',')}</span>
      <button onClick={() => void context.refreshOrganizations()}>Refresh</button>
    </>
  )
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}
describe('I01–I05 OrganizationsProvider registration barrier', () => {
  let root: Root
  let host: HTMLDivElement
  const response = { data: [{ id: 'org-1', name: 'Ready organization' }] }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sessionStorage.clear()
    fixture.api.listOrganizations.mockReset()
    fixture.entered.mockClear()
    fixture.auth.signinRedirect.mockReset()
    fixture.auth.user.profile.sub = 'user-1'
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  function invite() {
    const draft = registrationSession.prepare({ source: 'link', referredCode: 'ABCD2345EF' })
    registrationSession.restore(registrationSession.oidcState(draft), {
      issuer: 'https://issuer.test',
      userId: 'user-1',
    })
    return draft
  }
  async function mount() {
    await act(async () =>
      root.render(
        <StrictMode>
          <OrganizationsProvider>
            <Consumer />
          </OrganizationsProvider>
        </StrictMode>,
      ),
    )
    await flush()
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!
    expect(button).toBeTruthy()
    await act(async () => button.click())
    await flush()
  }
  it('sends the confirmed code once before mounting business children; refresh has no code', async () => {
    invite()
    let resolve: (value: typeof response) => void
    fixture.api.listOrganizations
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      .mockResolvedValue(response)
    await mount()
    expect(fixture.api.listOrganizations.mock.calls).toEqual([[{ referredCode: 'ABCD2345EF' }]])
    expect(fixture.entered).not.toHaveBeenCalled()
    await act(async () => resolve(response))
    await flush()
    expect(host.textContent).toContain('Ready organization')
    expect(registrationSession.read()).toBeNull()
    await click('Refresh')
    expect(fixture.api.listOrganizations.mock.calls).toEqual([[{ referredCode: 'ABCD2345EF' }], []])
  })
  it('retains the identical context after timeout and uses it for retry', async () => {
    const draft = invite()
    fixture.api.listOrganizations.mockRejectedValueOnce(new Error('Operation timed out')).mockResolvedValue(response)
    await mount()
    expect(registrationSession.read()?.contextId).toBe(draft.contextId)
    expect(fixture.entered).not.toHaveBeenCalled()
    await click('Retry')
    expect(fixture.api.listOrganizations.mock.calls).toEqual([
      [{ referredCode: 'ABCD2345EF' }],
      [{ referredCode: 'ABCD2345EF' }],
    ])
  })
  it('reauthentication can restart a first request suspended by the 401 interceptor', async () => {
    invite()
    fixture.api.listOrganizations.mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValue(response)
    await mount()
    expect(fixture.api.listOrganizations).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    root = createRoot(host)
    await mount()
    expect(fixture.api.listOrganizations).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Ready organization')
    expect(registrationSession.read()).toBeNull()
  })
  it.each([400, 403, 409, 410, 422])('blocks business calls on %i and keeps the invitation', async (status) => {
    invite()
    fixture.api.listOrganizations.mockRejectedValue({ message: 'Rejected', response: { status } })
    await mount()
    expect(fixture.entered).not.toHaveBeenCalled()
    expect(registrationSession.read()?.referredCode).toBe('ABCD2345EF')
    expect(fixture.api.listOrganizations).toHaveBeenCalledTimes(1)
    if (status === 409) {
      fixture.api.listOrganizations.mockResolvedValue(response)
      await click('ordinary login')
      expect(fixture.api.listOrganizations.mock.calls).toEqual([[{ referredCode: 'ABCD2345EF' }], []])
    }
  })
  it('ordinary login remains an unparameterized request', async () => {
    fixture.api.listOrganizations.mockResolvedValue(response)
    await mount()
    expect(fixture.api.listOrganizations.mock.calls).toEqual([[]])
    expect(host.textContent).toContain('Ready organization')
  })
  it('identity mismatch blocks the first HTTP request', async () => {
    const draft = registrationSession.prepare({ source: 'link', referredCode: 'ABCD2345EF' })
    registrationSession.restore(registrationSession.oidcState(draft), {
      issuer: 'https://issuer.test',
      userId: 'someone-else',
    })
    await mount()
    expect(fixture.api.listOrganizations).not.toHaveBeenCalled()
    expect(fixture.entered).not.toHaveBeenCalled()
    expect(host.textContent).toContain('identity changed')
  })
  it('ignores an earlier identity refresh that finishes after the new identity loads', async () => {
    let oldRefresh: (value: typeof response) => void
    fixture.api.listOrganizations
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldRefresh = resolve
          }),
      )
      .mockResolvedValue({ data: [{ id: 'org-2', name: 'New identity organization' }] })
    await mount()
    await click('Refresh')
    fixture.auth.user.profile.sub = 'user-2'
    await mount()
    expect(host.textContent).toContain('New identity organization')
    await act(async () => oldRefresh(response))
    expect(host.textContent).toContain('New identity organization')
    expect(host.textContent).not.toContain('Ready organization')
  })
})
