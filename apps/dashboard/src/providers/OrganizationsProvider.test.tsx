// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationsContext } from '@/contexts/OrganizationsContext'
import { act, Suspense, useContext, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrganizationsProvider } from './OrganizationsProvider'

const organizationsApiMock = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    organizationsApi: organizationsApiMock,
  }),
}))

function RefreshProbe() {
  const context = useContext(OrganizationsContext)
  const didRefresh = useRef(false)

  if (!context) {
    throw new Error('OrganizationsContext missing')
  }

  useEffect(() => {
    if (didRefresh.current) {
      return
    }

    didRefresh.current = true
    void context.refreshOrganizations('org-renamed')
  }, [context])

  return <div>{context.organizations.map((org) => org.name).join(', ')}</div>
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('OrganizationsProvider', () => {
  let root: Root | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    organizationsApiMock.listOrganizations.mockReset()
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('refreshes organization state without forcing a page reload', async () => {
    organizationsApiMock.listOrganizations
      .mockResolvedValueOnce({
        data: [{ id: 'org-original', name: 'Original Org', isDefaultForAuthenticatedUser: true }],
      })
      .mockResolvedValueOnce({
        data: [{ id: 'org-renamed', name: 'Renamed Org', isDefaultForAuthenticatedUser: true }],
      })

    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(
        <Suspense fallback={<div>Loading</div>}>
          <OrganizationsProvider>
            <RefreshProbe />
          </OrganizationsProvider>
        </Suspense>,
      )
    })

    for (let i = 0; i < 5 && !document.body.textContent?.includes('Renamed Org'); i += 1) {
      await flushReactWork()
    }

    expect(document.body.textContent).toContain('Renamed Org')
    expect(localStorage.getItem('SelectedOrganizationId')).toBe('org-renamed')
    expect(organizationsApiMock.listOrganizations).toHaveBeenCalledTimes(2)
  })
})
