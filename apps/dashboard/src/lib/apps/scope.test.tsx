// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { AgentHandoffPanel } from '@/components/apps/AgentHandoffPanel'
import { OrganizationScope } from '@/components/apps/OrganizationScope'
import { DomainsTab } from '@/components/apps/tabs/DomainsTab'
import type { AppDetail } from './types'
import { ApiClient } from '@/api/apiClient'
import { useCreateApp } from '@/hooks/mutations/useAppMutations'
import { useAppQuery, useAppsQuery } from '@/hooks/queries/useAppsQuery'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  organization: { id: 'org-a' } as { id: string } | null,
  permitted: true,
  api: null as ApiClient | null,
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => state.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: state.organization,
    authenticatedUserHasPermission: () => state.permitted,
  }),
}))

describe('cloud App organization isolation', () => {
  let root: Root
  let host: HTMLDivElement
  let cache: QueryClient
  let requests: InternalAxiosRequestConfig[]
  let respond: (request: InternalAxiosRequestConfig) => Promise<AxiosResponse>
  const adapter = axios.defaults.adapter
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const response = (request: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({
    config: request,
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
  })

  function render(children: ReactNode, path = '/dashboard/apps') {
    act(() =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
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

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.organization = { id: 'org-a' }
    state.permitted = true
    requests = []
    respond = async (request) => response(request, [{ id: 'one', name: 'current-app' }])
    axios.defaults.adapter = async (request) => {
      requests.push(request)
      return respond(request)
    }
    state.api = new ApiClient({ apiUrl: 'https://api.example.test/api' } as never, 'platform-token')
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    host = document.createElement('div')
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    cache.clear()
    axios.defaults.adapter = adapter
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('keeps a late list response in its original organization after switching', async () => {
    let releaseA: (() => void) | undefined
    respond = (request) =>
      request.url === '/v1/org-a/apps'
        ? new Promise((resolve) => {
            releaseA = () => resolve(response(request, [{ id: 'a', name: 'app-a' }]))
          })
        : Promise.resolve(response(request, [{ id: 'b', name: 'app-b' }]))
    function List() {
      const apps = useAppsQuery()
      return <div>{apps.data?.map((app) => app.name).join(',') ?? 'loading'}</div>
    }
    render(<List />)
    await act(async () => {
      await vi.waitFor(() => expect(releaseA).toBeDefined())
    })
    state.organization = { id: 'org-b' }
    render(<List />)
    await act(async () => {
      await vi.waitFor(() => expect(cache.getQueryData(queryKeys.apps.list('org-b'))).toBeDefined())
    })
    await act(async () => {
      releaseA?.()
    })
    await settled()
    expect(host.textContent).toBe('app-b')
    expect(cache.getQueryData(queryKeys.apps.list('org-a'))).toEqual([{ id: 'a', name: 'app-a' }])
    expect(requests.map((request) => request.url)).toEqual(['/v1/org-a/apps', '/v1/org-b/apps'])
    expect(requests.every((request) => request.headers.Authorization === 'Bearer platform-token')).toBe(true)
  })

  it('uses the explicit view endpoint and keeps the selected environment', async () => {
    respond = async (request) => response(request, { id: 'app-1', name: 'demo', status: 'draft', releases: [] })
    function Detail() {
      useAppQuery('app-1')
      return null
    }
    render(<Detail />, '/dashboard/apps/app-1?env=staging')
    await settled()
    expect(requests[0].url).toBe('/v1/org-a/apps/app-1/view')
    expect(requests[0].params).toEqual({ env: 'staging' })
  })

  it('invalidates only the organization which began a create even if the hook switches before completion', async () => {
    let create!: ReturnType<typeof useCreateApp>
    let release: (() => void) | undefined
    const created = { app: { id: 'new-app' }, prompt: 'boxlite-app init --app demo' }
    respond = (request) =>
      new Promise((resolve) => {
        release = () => resolve(response(request, created))
      })
    cache.setQueryData(queryKeys.apps.list('org-a'), [])
    cache.setQueryData(queryKeys.apps.list('org-b'), [])
    function Create() {
      create = useCreateApp()
      return null
    }
    render(<Create />)
    let pending!: ReturnType<typeof create.mutateAsync>
    act(() => {
      pending = create.mutateAsync({ name: 'demo' })
    })
    await act(async () => {
      await vi.waitFor(() => expect(release).toBeDefined())
    })
    state.organization = { id: 'org-b' }
    render(<Create />)
    await act(async () => {
      release?.()
      await expect(pending).resolves.toEqual(created)
    })
    expect(requests.map(({ method, url }) => [method, url])).toEqual([['post', '/v1/org-a/apps']])
    expect(cache.getQueryState(queryKeys.apps.list('org-a'))?.isInvalidated).toBe(true)
    expect(cache.getQueryState(queryKeys.apps.list('org-b'))?.isInvalidated).toBe(false)
  })

  it.each(['draft', 'live'])('copies the %s App environment setup without issuing a key', async (status) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const prompt = 'boxlite-app init --app demo --env staging'
    respond = async (request) =>
      response(request, {
        id: 'app-1',
        name: 'demo',
        status,
        environment: 'staging',
        releases: [],
        handoffPrompt: prompt,
      })
    function Detail() {
      const { data: app } = useAppQuery('app-1')
      return app ? <AgentHandoffPanel app={app} /> : null
    }
    render(<Detail />, '/dashboard/apps/app-1?env=staging')
    await settled()
    expect(host.querySelector('a[href="/dashboard/keys"]')?.textContent).toBe('API Keys')
    const copy = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Copy')
    expect(copy).toBeDefined()
    act(() => copy!.click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith(prompt)
    expect(requests.map(({ method, url, params }) => [method, url, params])).toEqual([
      ['get', '/v1/org-a/apps/app-1/view', { env: 'staging' }],
    ])
  })

  it.each(['missing organization', 'missing permission'])('does not request Apps with %s', async (reason) => {
    if (reason === 'missing organization') state.organization = null
    else state.permitted = false
    function List() {
      useAppsQuery()
      return null
    }
    render(<List />)
    await settled()
    expect(requests).toHaveLength(0)
  })

  it('refuses creating an App without write permission before sending the request', async () => {
    state.permitted = false
    let create!: ReturnType<typeof useCreateApp>
    function Create() {
      create = useCreateApp()
      return null
    }
    render(<Create />)
    await act(async () => {
      await expect(create.mutateAsync({ name: 'demo' })).rejects.toThrow('permission')
    })
    expect(requests).toHaveLength(0)
  })

  it('binds an existing platform domain in the App environment without a BYOD verification flow', async () => {
    respond = async (request) =>
      response(request, {
        host: 'friendly.apps.example.test',
        env: 'main',
        status: 'active',
        records: [],
        verified_at: null,
      })
    const detail = {
      id: 'app-one',
      name: 'demo',
      environment: 'main',
      url: 'https://default.apps.example.test',
      visibility: 'private',
      activeRelease: null,
      domains: { supported: true, target: null, list: [] },
    } as AppDetail
    render(<DomainsTab app={detail} />)
    expect(host.textContent).toContain('Bringing your own domain is not available')
    expect(host.querySelector('a[href="/dashboard/domains"]')).not.toBeNull()
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Bind domain')
        ?.click(),
    )
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'friendly.apps.example.test',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Bind domain')
        ?.click(),
    )
    await settled()
    expect(requests[0].url).toBe('/v1/org-a/apps/app-one/domains')
    expect(JSON.parse(requests[0].data)).toEqual({ host: 'friendly.apps.example.test' })
    expect(requests[0].params).toEqual({ env: 'main' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('resets local forms when the organization changes', () => {
    function Form() {
      const [value, setValue] = useState('')
      return <button onClick={() => setValue('draft')}>{value || 'empty'}</button>
    }
    render(
      <OrganizationScope>
        <Form />
      </OrganizationScope>,
    )
    act(() => host.querySelector('button')?.click())
    expect(host.textContent).toBe('draft')
    state.organization = { id: 'org-b' }
    render(
      <OrganizationScope>
        <Form />
      </OrganizationScope>,
    )
    expect(host.textContent).toBe('empty')
  })

  it('returns to the App list when switching from another organization’s App detail', async () => {
    function Location() {
      return <span>{useLocation().pathname}</span>
    }
    render(
      <OrganizationScope>
        <Location />
      </OrganizationScope>,
      '/dashboard/apps/app-a',
    )
    expect(host.textContent).toBe('/dashboard/apps/app-a')
    state.organization = { id: 'org-b' }
    render(
      <OrganizationScope>
        <Location />
      </OrganizationScope>,
    )
    await act(async () => {})
    expect(host.textContent).toBe('/dashboard/apps')
  })
})
