// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSuspensionBanner } from './useSuspensionBanner'

const mocks = vi.hoisted(() => ({
  addBanner: vi.fn(),
  removeBanner: vi.fn(),
  signinSilent: vi.fn(),
  removeUser: vi.fn(),
  signinRedirect: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  refreshOrganizations: vi.fn(),
  refreshOrganizationMembers: vi.fn(),
  toastError: vi.fn(),
  apiClientConstructor: vi.fn(),
}))

vi.mock('@/components/Banner', () => ({
  useBanner: () => ({ addBanner: mocks.addBanner, removeBanner: mocks.removeBanner }),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    signinSilent: mocks.signinSilent,
    removeUser: mocks.removeUser,
    signinRedirect: mocks.signinRedirect,
  }),
}))

vi.mock('@/api/apiClient', () => ({
  ApiClient: vi.fn().mockImplementation(function (...args) {
    mocks.apiClientConstructor(...args)
    return {
      userApi: {
        getAuthenticatedUser: mocks.getAuthenticatedUser,
      },
    }
  }),
}))

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: 'https://api.boxlite.test' }),
}))

vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({ refreshOrganizations: mocks.refreshOrganizations }),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    refreshOrganizationMembers: mocks.refreshOrganizationMembers,
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
  },
}))

function Harness() {
  useSuspensionBanner({
    suspended: true,
    suspensionReason: 'Please verify your email address',
    suspendedAt: new Date('2026-07-07T00:00:00.000Z'),
    suspensionCleanupGracePeriodHours: 24,
  })
  return null
}

async function renderHookAt(path = '/dashboard/boxes?filter=active') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Harness />
      </MemoryRouter>,
    )
  })
  return root
}

function latestBannerAction() {
  const notification = mocks.addBanner.mock.calls.at(-1)?.[0]
  expect(notification).toMatchObject({
    title: 'Verification Required',
    action: expect.objectContaining({ label: 'I verified my email' }),
  })
  return notification.action as { label: string; onClick: () => Promise<void> | void }
}

describe('useSuspensionBanner verify-email recovery', () => {
  const roots: Root[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.signinSilent.mockResolvedValue({
      access_token: 'fresh-token',
      profile: { email_verified: true },
    })
    mocks.getAuthenticatedUser.mockResolvedValue({ data: { id: 'user-1', emailVerified: true } })
    mocks.refreshOrganizations.mockResolvedValue(undefined)
    mocks.refreshOrganizationMembers.mockResolvedValue([])
    mocks.removeUser.mockResolvedValue(undefined)
    mocks.signinRedirect.mockResolvedValue(undefined)
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => root.unmount())
    document.body.replaceChildren()
  })

  it('adds a CTA to the verify-email suspension banner', async () => {
    const root = await renderHookAt()
    roots.push(root)

    expect(latestBannerAction().label).toBe('I verified my email')
  })

  it('syncs the backend identity and refreshes org state when silent refresh confirms verification', async () => {
    const root = await renderHookAt()
    roots.push(root)

    await act(async () => {
      await latestBannerAction().onClick()
    })

    expect(mocks.signinSilent).toHaveBeenCalledTimes(1)
    expect(mocks.apiClientConstructor).toHaveBeenCalledWith({ apiUrl: 'https://api.boxlite.test' }, 'fresh-token')
    expect(mocks.getAuthenticatedUser).toHaveBeenCalledTimes(1)
    expect(mocks.refreshOrganizations).toHaveBeenCalledWith('org-1')
    expect(mocks.refreshOrganizationMembers).toHaveBeenCalledTimes(1)
    expect(mocks.removeUser).not.toHaveBeenCalled()
    expect(mocks.signinRedirect).not.toHaveBeenCalled()
  })

  it('falls back to redirect login with returnTo when silent refresh fails', async () => {
    mocks.signinSilent.mockRejectedValueOnce(new Error('login_required'))
    const root = await renderHookAt('/dashboard/boxes?page=2')
    roots.push(root)

    await act(async () => {
      await latestBannerAction().onClick()
    })

    expect(mocks.removeUser).toHaveBeenCalledTimes(1)
    expect(mocks.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: '/dashboard/boxes?page=2' },
    })
  })

  it('falls back to redirect login when the refreshed profile is still not verified', async () => {
    mocks.signinSilent.mockResolvedValueOnce({
      access_token: 'fresh-token',
      profile: { email_verified: false },
    })
    const root = await renderHookAt('/dashboard/boxes?onboarding=1')
    roots.push(root)

    await act(async () => {
      await latestBannerAction().onClick()
    })

    expect(mocks.getAuthenticatedUser).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('We could not confirm verification yet. Try again in a moment.')
    expect(mocks.removeUser).toHaveBeenCalledTimes(1)
    expect(mocks.signinRedirect).toHaveBeenCalledWith({
      state: { returnTo: '/dashboard/boxes?onboarding=1' },
    })
  })
})
