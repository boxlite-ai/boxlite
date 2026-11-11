// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CiRepositoryDetails } from './CiRepositoryDetails'

describe('CI installed repository details', () => {
  let root: Root, cache: QueryClient
  const api = { getCiRepositories: vi.fn() }
  const first = {
    repositories: [{ id: 21, name: 'web', private: false, owner: { id: 7, login: 'owner' } }],
    total: 26,
    page: 1,
    next_page: 2,
    repository_selection: 'selected',
    installation_settings_url: 'https://github.com/settings/installations/11',
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    api.getCiRepositories.mockReset().mockResolvedValue(first)
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    cache.clear()
    document.body.innerHTML = ''
  })
  async function render(managementUrl = first.installation_settings_url) {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <CiRepositoryDetails
            api={api}
            organization="org"
            context={{ kind: 'binding', id: 'binding' }}
            installation={11}
            account="owner"
            managementUrl={managementUrl}
          />
        </QueryClientProvider>,
      ),
    )
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain('owner/web'))
    })
  }
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label)!
  it('shows authorized visibility and the original installation settings, then fetches the next bounded page', async () => {
    await render()
    expect(document.body.textContent).toContain('Public')
    expect(document.querySelector('a')?.getAttribute('href')).toBe(first.installation_settings_url)
    api.getCiRepositories.mockResolvedValue({
      ...first,
      page: 2,
      next_page: null,
      repositories: [{ ...first.repositories[0], id: 22, name: 'api', private: true }],
    })
    await act(async () => button('Next').click())
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain('owner/api'))
    })
    expect(document.body.textContent).toContain('Private')
    expect(api.getCiRepositories).toHaveBeenLastCalledWith(
      'org',
      { kind: 'binding', id: 'binding' },
      2,
      expect.any(AbortSignal),
    )
  })
  it('preserves Previous and installation repair after a later page fails', async () => {
    await render()
    api.getCiRepositories.mockRejectedValue(Error('unavailable'))
    await act(async () => button('Next').click())
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull())
    })
    expect(button('Previous').disabled).toBe(false)
    expect(document.querySelector('a')?.textContent).toContain('Install app for repos')
    api.getCiRepositories.mockResolvedValue(first)
    await act(async () => button('Previous').click())
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain('owner/web'))
    })
  })
  it('does not poll on ordinary focus; settings return cancels a delayed page and refreshes page one', async () => {
    await render()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.getCiRepositories).toHaveBeenCalledTimes(1)
    let signal: AbortSignal | undefined, finish!: (value: unknown) => void
    api.getCiRepositories.mockImplementationOnce((_org, _context, _page, active: AbortSignal) => {
      signal = active
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    await act(async () => button('Next').click())
    await act(async () => document.querySelector<HTMLAnchorElement>('a')!.click())
    api.getCiRepositories.mockResolvedValue({
      ...first,
      total: 1,
      next_page: null,
      repositories: [{ ...first.repositories[0], name: 'new-repo' }],
    })
    await act(async () => window.dispatchEvent(new Event('focus')))
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain('owner/new-repo'))
    })
    expect(signal?.aborted).toBe(true)
    await act(async () => finish({ ...first, page: 2, repositories: [{ ...first.repositories[0], name: 'stale' }] }))
    expect(document.body.textContent).not.toContain('owner/stale')
  })
  it.each([
    'https://outside.test/settings/installations/11',
    'https://github.com/settings/installations/12',
    'https://github.com/settings/installations/11?token=x',
  ])('does not render an unbound management URL: %s', async (url) => {
    await render(url)
    expect(document.querySelector('a')).toBeNull()
  })
})
