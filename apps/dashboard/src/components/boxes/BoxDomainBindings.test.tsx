// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { keepPreviousData, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DomainList, HeldDomain } from '@/api/domain-types'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { BoxDomainBindings } from './BoxDomainBindings'

const mocks = vi.hoisted(() => ({ org: 'org-1', listDomains: vi.fn() }))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ listDomains: mocks.listDomains }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: mocks.org } }),
}))
vi.mock('@/components/CopyButton', () => ({
  CopyButton: ({ value }: { value: string }) => <button data-copy={value}>Copy</button>,
}))
let root: Root
let client: QueryClient
let container: HTMLDivElement
const domain = (hostname: string, target: HeldDomain['target']): HeldDomain => ({
  hostname,
  url: `https://${hostname}`,
  target,
})
const bound = domain('web.example', { type: 'box', box: 'box-1', port: 3000 })
function result(domains: HeldDomain[]): DomainList {
  return { domains, limit: 5, used: domains.length, remaining: 5 - domains.length, min_length: 3, domain_suffix: null }
}
async function render(boxId = 'box-1', canManage = true) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BoxDomainBindings boxId={boxId} canManage={canManage} />
      </QueryClientProvider>,
    ),
  )
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.org = 'org-1'
  mocks.listDomains.mockReset().mockResolvedValue(result([bound]))
  client = new QueryClient({ defaultOptions: { queries: { retry: false, placeholderData: keepPreviousData } } })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})

it('shows only current Box bindings with their port and exact URL actions', async () => {
  mocks.listDomains.mockResolvedValue(
    result([
      bound,
      domain('other.example', { type: 'box', box: 'box-2', port: 8080 }),
      domain('app.example', { type: 'app', app: 'shop' }),
      domain('unbound.example', null),
    ]),
  )
  await render()
  await settle()
  expect(mocks.listDomains).toHaveBeenCalledWith('org-1')
  expect([...container.querySelectorAll('li')].map((row) => row.textContent)).toEqual(['web.example:3000Copy'])
  expect(container.querySelector('a')?.getAttribute('href')).toBe('https://web.example')
  expect(container.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe('https://web.example')
  await render('box-2')
  expect(container.textContent).toContain('other.example:8080')
  expect(container.textContent).not.toContain('web.example')
})

it('distinguishes loading from a successful empty list', async () => {
  let resolve!: (value: DomainList) => void
  mocks.listDomains.mockReturnValue(
    new Promise<DomainList>((done) => {
      resolve = done
    }),
  )
  await render()
  expect(container.textContent).toContain('Loading domains…')
  expect(container.textContent).not.toContain('No domains bound.')
  await act(async () => resolve(result([])))
  await settle()
  expect(container.textContent).toContain('No domains bound.')
})

it('offers retry after failure, without falsely reporting empty', async () => {
  mocks.listDomains.mockRejectedValueOnce(new Error('unavailable'))
  await render()
  await settle()
  expect(container.textContent).toContain('Could not load domains.')
  expect(container.textContent).not.toContain('No domains bound.')
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
  await settle()
  expect(container.textContent).toContain('web.example:3000')
})

it('does not fetch without permission and immediately hides cached bindings on permission loss', async () => {
  await render('box-1', false)
  expect(mocks.listDomains).not.toHaveBeenCalled()
  expect(container.textContent).toContain('require management permission')
  await render()
  await settle()
  expect(container.textContent).toContain('web.example')
  await render('box-1', false)
  expect(container.textContent).not.toContain('web.example')
  expect(container.querySelector('a')).toBeNull()
})

it('does not display previous organization data during an organization switch', async () => {
  await render()
  await settle()
  expect(container.textContent).toContain('web.example')
  mocks.org = 'org-2'
  mocks.listDomains.mockReturnValue(new Promise(() => {}))
  await render()
  expect(container.textContent).toContain('Loading domains…')
  expect(container.textContent).not.toContain('web.example')
  expect(mocks.listDomains).toHaveBeenLastCalledWith('org-2')
})

it('retains known bindings with an explicit refresh failure', async () => {
  await render()
  await settle()
  mocks.listDomains.mockRejectedValue(new Error('offline'))
  await act(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.domains.list('org-1') })
  })
  await settle()
  expect(container.textContent).toContain('Could not refresh domains.')
  expect(container.textContent).toContain('web.example:3000')
})

it.each(['javascript:alert(1)', 'https://user:secret@web.example', 'not a URL'])(
  'does not expose unsafe URL actions for %s',
  async (url) => {
    mocks.listDomains.mockResolvedValue(result([{ ...bound, url }]))
    await render()
    await settle()
    expect(container.textContent).toContain('web.example:3000')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[data-copy]')).toBeNull()
  },
)
