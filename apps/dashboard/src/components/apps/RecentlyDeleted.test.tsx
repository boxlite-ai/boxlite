// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { ApiClient } from '@/api/apiClient'
import { usePurgeApp } from '@/hooks/mutations/useAppMutations'
import { queryKeys } from '@/hooks/queries/queryKeys'
import type { DeletedApp } from '@/lib/apps/types'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrganizationScope } from './OrganizationScope'
import { setAppHostingIntroSeen } from '@/lib/apps/intro'
import { RecentlyDeleted } from './RecentlyDeleted'

const state = vi.hoisted(() => ({
  organization: { id: 'org-a' },
  canDelete: true,
  api: null as ApiClient | null,
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => state.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: state.organization,
    authenticatedUserHasPermission: (permission: OrganizationRolePermissionsEnum) =>
      permission !== OrganizationRolePermissionsEnum.DELETE_APPS || state.canDelete,
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('Recently deleted Apps permanent deletion', () => {
  let root: Root
  let cache: QueryClient
  let requests: InternalAxiosRequestConfig[]
  let deleted: DeletedApp[]
  let respond: (request: InternalAxiosRequestConfig) => Promise<AxiosResponse>
  const adapter = axios.defaults.adapter
  const starter: DeletedApp = {
    name: 'starter',
    deletedAt: new Date(Date.now() - 86_400_000).toISOString(),
    purgeAfter: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    environments: 1,
  }
  const deletedKey = (organization: string) => [...queryKeys.apps.organization(organization), 'deleted']
  const response = (request: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse => ({
    config: request,
    data,
    status,
    statusText: status === 204 ? 'No Content' : 'OK',
    headers: {},
  })
  const action = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const writes = () => requests.filter(({ method }) => method !== 'get')
  const confirmButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === 'Delete permanently',
    )!

  function render(children: ReactNode = <RecentlyDeleted />) {
    act(() =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <OrganizationScope>{children}</OrganizationScope>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    )
  }

  async function settled() {
    await act(async () => {
      await vi.waitFor(() => expect(cache.isFetching()).toBe(0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async function openDelete() {
    await act(async () => action('Delete starter')!.click())
  }

  function typeName(value: string) {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    setAppHostingIntroSeen(true)
    state.organization = { id: 'org-a' }
    state.canDelete = true
    requests = []
    deleted = [starter]
    respond = async (request) => {
      if (request.method === 'get') return response(request, deleted)
      deleted = []
      return response(request, undefined, request.method === 'delete' ? 204 : 200)
    }
    axios.defaults.adapter = async (request) => {
      requests.push(request)
      return respond(request)
    }
    state.api = new ApiClient({ apiUrl: 'https://api.example.test/api' } as never, 'platform-token')
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    cache.clear()
    sessionStorage.clear()
    axios.defaults.adapter = adapter
    document.body.innerHTML = ''
  })

  it('places Delete after Restore and requires the exact App name before sending a permanent delete', async () => {
    render()
    await settled()
    expect([...document.querySelectorAll('section button')].map((button) => button.textContent)).toEqual([
      'Restore',
      'Delete',
    ])
    await openDelete()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Permanently delete starter?')
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)
    expect(description).not.toBeNull()
    expect(description!.textContent).toContain('This cannot be undone')
    expect(confirmButton().disabled).toBe(true)
    for (const value of ['STARTER', 'starter ', ' starter']) {
      typeName(value)
      expect(confirmButton().disabled).toBe(true)
    }
    expect(writes()).toHaveLength(0)
    typeName('starter')
    expect(confirmButton().disabled).toBe(false)
    await act(async () => confirmButton().click())
    await settled()
    expect(writes().map(({ method, url }) => [method, url])).toEqual([['delete', '/v1/org-a/apps/deleted/starter']])
    expect(writes()[0].headers.Authorization).toBe('Bearer platform-token')
    expect(document.querySelector('section[aria-label="Recently deleted"]')).toBeNull()
    expect(requests.filter(({ method }) => method === 'get')).toHaveLength(2)
    expect(toast.success).toHaveBeenCalledWith('starter permanently deleted')
  })

  it('cancels without a request and clears the typed name when the confirmation opens again', async () => {
    render()
    await settled()
    await openDelete()
    typeName('starter')
    await act(async () => {
      ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Cancel')!
        .click()
    })
    expect(writes()).toHaveLength(0)
    await openDelete()
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe('')
    expect(confirmButton().disabled).toBe(true)
  })

  it('disables Restore and Delete without App delete permission', async () => {
    state.canDelete = false
    render()
    await settled()
    expect(action('Restore starter')!.disabled).toBe(true)
    expect(action('Delete starter')!.disabled).toBe(true)
    await act(async () => action('Delete starter')!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(writes()).toHaveLength(0)
  })

  it('refuses permanent deletion without App delete permission before sending a request', async () => {
    state.canDelete = false
    let purge!: ReturnType<typeof usePurgeApp>
    function Probe() {
      purge = usePurgeApp()
      return null
    }
    render(<Probe />)
    await act(async () => {
      await expect(purge.mutateAsync('starter')).rejects.toThrow('permission')
    })
    expect(requests).toHaveLength(0)
  })

  it('blocks further row actions while deletion is pending and keeps the App visible after failure', async () => {
    let rejectDelete!: (error: Error) => void
    respond = async (request) =>
      request.method === 'delete'
        ? new Promise((_resolve, reject) => {
            rejectDelete = (error) => {
              deleted = [{ ...starter, purgeAfter: new Date(Date.now() - 1000).toISOString() }]
              reject(error)
            }
          })
        : response(request, deleted)
    render()
    await settled()
    await openDelete()
    typeName('starter')
    await act(async () => confirmButton().click())
    expect(action('Restore starter')!.disabled).toBe(true)
    expect(action('Delete starter')!.disabled).toBe(true)
    expect(action('Delete starter')!.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
    await act(async () => rejectDelete(new Error('Storage cleanup failed')))
    await settled()
    expect(action('Restore starter')!.disabled).toBe(true)
    expect(action('Delete starter')!.disabled).toBe(false)
    expect(requests.filter(({ method }) => method === 'get')).toHaveLength(2)
    expect(toast.error).toHaveBeenCalledWith('Could not permanently delete starter', {
      description: 'Storage cleanup failed',
      action: undefined,
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('disables Restore after retention expires while keeping Delete available', async () => {
    deleted = [{ ...starter, purgeAfter: new Date(Date.now() - 1000).toISOString() }]
    render()
    await settled()
    expect(action('Restore starter')!.disabled).toBe(true)
    expect(action('Restore starter')!.title).toContain('retention period has ended')
    expect(action('Delete starter')!.disabled).toBe(false)
  })

  it('keeps Restore working and refreshes Recently deleted after restoration', async () => {
    render()
    await settled()
    await act(async () => action('Restore starter')!.click())
    await settled()
    expect(writes().map(({ method, url }) => [method, url])).toEqual([
      ['post', '/v1/org-a/apps/deleted/starter/restore'],
    ])
    expect(document.querySelector('section[aria-label="Recently deleted"]')).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('starter restored', expect.any(Object))
  })

  it('refreshes only the organization that began deletion after switching organizations', async () => {
    let finishDelete!: () => void
    respond = async (request) =>
      request.method === 'delete'
        ? new Promise((resolve) => {
            finishDelete = () => resolve(response(request, undefined, 204))
          })
        : response(request, deleted)
    cache.setQueryData(deletedKey('org-a'), [starter])
    cache.setQueryData(deletedKey('org-b'), [{ ...starter, name: 'other-app' }])
    render()
    await openDelete()
    typeName('starter')
    await act(async () => confirmButton().click())
    state.organization = { id: 'org-b' }
    render()
    await act(async () => finishDelete())
    await settled()
    expect(action('Delete other-app')).not.toBeNull()
    expect(cache.getQueryState(deletedKey('org-a'))!.isInvalidated).toBe(true)
    expect(cache.getQueryState(deletedKey('org-b'))!.isInvalidated).toBe(false)
    expect(writes().map(({ method, url }) => [method, url])).toEqual([['delete', '/v1/org-a/apps/deleted/starter']])
  })
})
