// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum as P } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Keys from './Keys'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => []),
  status: undefined as 'error' | undefined,
  create: vi.fn(async () => ({ value: 'test-key', permissions: ['write:boxes'] })),
  member: { userId: 'user', role: 'owner', assignedRoles: [] } as {
    userId?: string
    role: string
    assignedRoles: { permissions: string[] }[]
  } | null,
}))

vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: 'user' } } }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ apiUrl: 'https://api.example.com' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    refreshOrganizationMembers: mocks.refresh,
    organizationMembersStatus: mocks.status,
    authenticatedUserOrganizationMember: mocks.member,
  }),
}))
vi.mock('@/hooks/queries/useApiKeysQuery', () => ({ useApiKeysQuery: () => ({ data: [] }) }))
vi.mock('@/hooks/mutations/useRevokeApiKeyMutation', () => ({ useRevokeApiKeyMutation: () => ({}) }))
vi.mock('@/hooks/mutations/useCreateApiKeyMutation', () => ({
  useCreateApiKeyMutation: () => ({ mutateAsync: mocks.create }),
}))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => [null, vi.fn()] }))
vi.mock('@/components/ApiKeyTable', () => ({ ApiKeyTable: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('console member key defaults', () => {
  let root: Root

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  afterAll(() => vi.unstubAllGlobals())

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.status = undefined
    mocks.member = { role: 'owner', assignedRoles: [] }
  })

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  async function createKey(adjustPermissions?: () => Promise<void>) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<Keys />)
    })
    await act(async () => document.querySelector<HTMLButtonElement>('button[title="New API key"]')?.click())
    const name = document.querySelector<HTMLInputElement>('input[placeholder="Name"]')
    expect(name).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(name, 'automation')
      name?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await adjustPermissions?.()
    await act(async () => {
      document
        .querySelector('#create-api-key-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    return (mocks.create.mock.calls[0] as unknown as [{ permissions: string[] }])[0].permissions
  }

  it('preserves the open draft when membership finishes loading', async () => {
    mocks.member = null
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<Keys />)
    })
    await act(async () => document.querySelector<HTMLButtonElement>('button[title="New API key"]')!.click())
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Name"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'draft-agent')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    mocks.member = { userId: 'user', role: 'owner', assignedRoles: [] }
    await act(async () => root.render(<Keys />))
    expect(document.querySelector<HTMLInputElement>('input[placeholder="Name"]')?.value).toBe('draft-agent')
  })

  it('connects the failed membership state to the refresh action', async () => {
    mocks.status = 'error'
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<Keys />)
    })
    await act(async () => document.querySelector<HTMLButtonElement>('button[title="New API key"]')!.click())
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Refresh permissions',
    )!
    await act(async () => retry.click())
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('defaults to all API key permissions for an owner', async () => {
    const permissions = await createKey()

    expect(permissions).toEqual(Object.values(P).filter((permission) => permission !== P.UNKNOWN_DEFAULT_OPEN_API))
  })

  it.each(['owner', 'member'])('lets a %s limit an API key to Apps through Adjust permissions', async (role) => {
    const appPermissions = ['read:apps', 'write:apps']
    if (role === 'member') {
      mocks.member = { role, assignedRoles: [{ permissions: ['write:boxes', ...appPermissions] }] }
    }

    const permissions = await createKey(async () => {
      const adjust = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Adjust permissions',
      )!
      await act(async () => adjust.click())
      const group = document.querySelector('fieldset[aria-label="Apps"]')!
      expect(group).not.toBeNull()
      const checkboxes = document.querySelectorAll<HTMLButtonElement>('[role="checkbox"][aria-checked="true"]')
      for (const checkbox of checkboxes) {
        if (appPermissions.some((permission) => checkbox.id.endsWith(`-${permission}`))) continue
        const details = checkbox.closest('details')!
        if (!details.open) await act(async () => details.querySelector('summary')!.click())
        await act(async () => checkbox.click())
      }
      expect(document.querySelector('[role="combobox"][aria-label="Access"]')?.textContent).toBe('Custom access')
      expect(group.querySelector('[id$="-delete:apps"]') !== null).toBe(role === 'owner')
    })

    expect([...permissions].sort()).toEqual([...appPermissions].sort())
    const request = mocks.create.mock.calls[0] as unknown as [{ expiresAt: Date }]
    const days = (request[0].expiresAt.getTime() - Date.now()) / 86400000
    expect(days).toBeGreaterThan(29.99)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('defaults to the member’s assigned Console permissions', async () => {
    mocks.member = {
      role: 'member',
      assignedRoles: [{ permissions: ['write:boxes', 'read:members', 'write:members'] }],
    }
    const permissions = await createKey()

    expect(permissions).toEqual(['write:boxes', 'read:members'])
    expect(permissions).not.toContain('write:members')
  })

  it('creates an Apps key for a member without Box operations', async () => {
    mocks.member = { role: 'member', assignedRoles: [{ permissions: ['read:apps', 'write:apps'] }] }

    expect(await createKey()).toEqual(['read:apps', 'write:apps'])
  })

  it('does not grant member scopes to a member without them', async () => {
    mocks.member = { role: 'member', assignedRoles: [{ permissions: ['write:boxes'] }] }

    expect(await createKey()).toEqual(['write:boxes'])
  })
})
