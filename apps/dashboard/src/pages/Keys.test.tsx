// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Keys from './Keys'

const query = vi.hoisted(() => ({
  data: undefined as { name: string }[] | undefined,
  isError: false,
  isLoading: false,
  isFetching: false,
  isRefetching: false,
  refetch: vi.fn(),
}))
vi.mock('@/hooks/queries/useApiKeysQuery', () => ({ useApiKeysQuery: () => query }))
vi.mock('@/hooks/mutations/useRevokeApiKeyMutation', () => ({
  useRevokeApiKeyMutation: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ apiUrl: '/api' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org' } }),
}))
vi.mock('@/components/CreateApiKeyDialog', () => ({ CreateApiKeyDialog: () => null }))
vi.mock('@/components/ApiKeyTable', () => ({
  ApiKeyTable: ({ data, loading }: { data: { name: string }[]; loading: boolean }) => (
    <div data-testid="inventory">{loading ? 'Table loading' : data.map((key) => key.name).join(', ')}</div>
  ),
}))
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  query.data = undefined
  query.isError = false
  query.isLoading = false
  query.isFetching = false
  query.isRefetching = false
  query.refetch.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('offers retry without mounting an empty key inventory after initial failure', async () => {
  query.isError = true
  act(() => root.render(<Keys />))
  const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')
  expect(retry).toBeDefined()
  expect(host.querySelector('[data-testid="inventory"]')).toBeNull()
  await act(async () => retry?.click())
  expect(query.refetch).toHaveBeenCalledTimes(1)
})

it('keeps cached keys visible while a failed refresh is retried', async () => {
  query.data = [{ name: 'deploy-key' }]
  query.isError = true
  query.isRefetching = true
  query.isFetching = true
  act(() => root.render(<Keys />))
  expect(host.querySelector('[data-testid="inventory"]')?.textContent).toBe('deploy-key')
  const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retrying…')
  expect(retry?.disabled).toBe(true)
  query.isFetching = false
  query.isRefetching = false
  act(() => root.render(<Keys />))
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')?.click())
  expect(query.refetch).toHaveBeenCalledTimes(1)
})
