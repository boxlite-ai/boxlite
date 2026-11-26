// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { ApiClient } from '@/api/apiClient'
import AppDetailsPage from '@/components/apps/AppDetails'
import { LiveCard } from '@/components/apps/OverviewHero'
import AppsPage from '@/pages/Apps'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDetail, EnvironmentSummary } from './types'

const state = vi.hoisted(() => ({ api: null as ApiClient | null }))
vi.mock('@/hooks/useApi', () => ({ useApi: () => state.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-a', appHostingPermissions: ['read:apps'] },
    authenticatedUserHasPermission: () => true,
  }),
}))
vi.mock('@/lib/apps/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apps/download')>()),
  AppImage: ({ path: _path, ...props }: ComponentProps<'img'> & { path: string }) => <img {...props} />,
}))

const APP_URL = 'https://demo.apps.example.test/'

function detail(url: string | null = null): AppDetail {
  return {
    id: 'demo',
    appId: 'app-one',
    name: 'demo',
    slug: 'demo',
    url,
    visibility: 'private',
    status: 'live',
    lastDeploy: { releaseId: '#1', at: '2026-11-18T00:00:00Z', by: 'user' },
    resources: { database: false, storage: 0, users: 0 },
    createdAt: '2026-11-18T00:00:00Z',
    environment: 'main',
    createdFrom: null,
    runtime: null,
    box: null,
    services: [],
    activeRelease: '#1',
    releases: [],
    activity: [],
    database: null,
    storages: [],
    secrets: [],
    variables: null,
    platformVariables: [],
    problems: [],
    statusDetail: null,
    deploying: null,
    schedules: [],
    liveVariables: null,
    metrics: null,
    preview: null,
    previewAttempt: null,
    handoffPrompt: 'boxlite-app init --app demo',
    accessSource: 'manifest',
    specVersion: null,
    auth: {
      declared: true,
      providers: ['github'],
      protect: ['/*'],
      enforced: true,
      methods: [
        {
          provider: 'github',
          label: 'GitHub',
          status: 'ready',
          declared: true,
          redirectUri: 'https://api.example.test/auth/callback/github',
          keys: 'shared',
          clientId: null,
          managedAvailable: true,
        },
      ],
      loginUrl: url ? `${url}.boxlite/auth/login` : null,
      users: 0,
      note: null,
    },
    domains: { supported: true, target: null, list: [] },
  }
}

describe('cloud App URL availability', () => {
  let root: Root
  let host: HTMLDivElement
  let cache: QueryClient
  let app: AppDetail
  let requests: InternalAxiosRequestConfig[]
  const adapter = axios.defaults.adapter

  function render(path = '/dashboard/apps', children?: ReactNode) {
    act(() =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={[path]}>
            {children ?? (
              <Routes>
                <Route path="/dashboard/apps" element={<AppsPage />} />
                <Route path="/dashboard/apps/:appId" element={<AppDetailsPage />} />
              </Routes>
            )}
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

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    app = detail()
    requests = []
    axios.defaults.adapter = async (request) => {
      requests.push(request)
      let data: unknown
      if (request.url === '/v1/org-a/apps') data = [{ ...app, environments: 1 }]
      else if (request.url === '/v1/org-a/apps/deleted') data = []
      else if (request.url?.endsWith('/view')) data = app
      else if (request.url?.endsWith('/environments'))
        data = [
          { name: 'main', status: app.status, url: app.url, box: null, lastDeploy: app.lastDeploy, from: null },
        ] satisfies EnvironmentSummary[]
      else if (request.url?.endsWith('/auth')) data = { status: app.auth, users: [], events: [] }
      else throw new Error(`Unexpected request: ${request.method} ${request.url}`)
      return { config: request, data, status: 200, statusText: 'OK', headers: {} } satisfies AxiosResponse
    }
    state.api = new ApiClient({ apiUrl: 'https://api.example.test/api' } as never, 'platform-token')
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    cache.clear()
    axios.defaults.adapter = adapter
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it.each([
    { mocking: 'false', url: null },
    { mocking: 'true', url: APP_URL },
  ])('an invited reader follows an App card with mocking=$mocking and URL $url', async ({ mocking, url }) => {
    vi.stubEnv('VITE_ENABLE_MOCKING', mocking)
    app = detail(url)
    render()
    await settled()
    expect(host.textContent).toContain('New app')
    const link = host.querySelector<HTMLAnchorElement>('a[aria-label="Open demo"]')!
    expect(link.getAttribute('href')).toBe('/dashboard/apps/demo')
    expect(host.querySelector('[aria-label="Open demo in a new tab"]') !== null).toBe(!!url)
    expect(link.closest('article')?.textContent).toContain(url ? 'demo.apps.example.test' : 'URL unavailable')
    await act(async () => link.click())
    await settled()
    expect(host.querySelector('h1')?.textContent).toBe('demo')
    expect(host.textContent).toContain('Keep building with your agent')
    expect(host.querySelector('button[title="Copy URL"]') !== null).toBe(!!url)
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Open app'))).toBe(!!url)
    expect(requests.map(({ method, url }) => `${method} ${url}`).sort()).toEqual([
      'get /v1/org-a/apps',
      'get /v1/org-a/apps/deleted',
      'get /v1/org-a/apps/demo/environments',
      'get /v1/org-a/apps/demo/view',
    ])
  })

  it('opens the linked App and environment immediately for an invited reader', async () => {
    render('/dashboard/apps/demo?env=staging')
    await settled()
    expect(host.querySelector('h1')?.textContent).toBe('demo')
    expect(requests.find((request) => request.url === '/v1/org-a/apps/demo/view')?.params).toEqual({ env: 'staging' })
  })

  it('keeps Domains management available without a primary URL or copy/open controls', async () => {
    render('/dashboard/apps/demo?tab=domains')
    await settled()
    expect(host.textContent).toContain('URL unavailable')
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Bind domain')).toBe(true)
    expect(host.querySelector('button[title="Copy URL"]')).toBeNull()
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Open app'))).toBe(false)
    expect(requests.every(({ method }) => method === 'get')).toBe(true)
  })

  it.each([null, `${APP_URL}.boxlite/auth/login`])(
    'offers Test login only with an actual login URL: %s',
    async (loginUrl) => {
      app = detail(APP_URL)
      app.auth.loginUrl = loginUrl
      render('/dashboard/apps/demo?tab=auth&section=methods')
      await settled()
      const login = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
        link.textContent?.includes('Test login'),
      )
      expect(login !== undefined).toBe(!!loginUrl)
      if (loginUrl) expect(login!.href).toBe(loginUrl)
      expect(host.querySelector('[aria-label="Auth settings"]')).not.toBeNull()
    },
  )

  it('shows an environment without a URL in the switcher', async () => {
    render('/dashboard/apps/demo?tab=auth&section=methods')
    await settled()
    const switcher = host.querySelector<HTMLButtonElement>('button[aria-label="Switch environment"]')!
    await act(async () => switcher.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    const environment = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('main'),
    )
    expect(environment?.textContent).toContain('URL unavailable')
  })

  it('keeps an existing preview static when its environment has no URL', () => {
    app.preview = { src: '/apps/demo/preview', capturedAt: '2026-11-18T00:00:00Z', releaseId: '#1' }
    render('/dashboard/apps/demo', <LiveCard app={app} active={null} failing={false} onGoTo={() => undefined} />)
    const preview = host.querySelector('img[alt="demo at #1"]')!
    expect(preview).not.toBeNull()
    expect(preview.closest('button')).toBeNull()
    expect(host.querySelector('button[title="Copy URL"]')).toBeNull()
    expect(host.querySelector('button[title="Take a new picture"]')).toBeNull()
  })
})
