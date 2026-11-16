// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyList, ApiKeyListPermissionsEnum as P } from '@boxlite-ai/api-client'
import { ApiKeyTable } from './ApiKeyTable'
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})
describe('API key inventory permissions', () => {
  it('names the default Box operations scope and marks expired keys', async () => {
    const key: ApiKeyList = {
      name: 'agent',
      value: 'masked',
      userId: 'user',
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: new Date(0),
      permissions: [P.WRITE_BOXES],
    }
    await act(async () =>
      root.render(<ApiKeyTable data={[key]} loading={false} isLoadingKey={() => false} onRevoke={vi.fn()} />),
    )
    expect(document.body.textContent).toContain('Box operations')
    expect(document.body.textContent).toContain('Expired')
    expect(document.body.textContent).not.toContain('Restricted')
  })
  it('preserves scopes outside the console selection groups', async () => {
    const key: ApiKeyList = {
      name: 'audit',
      value: 'masked',
      userId: 'user',
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: null,
      permissions: [P.READ_AUDIT_LOGS],
    }
    await act(async () =>
      root.render(<ApiKeyTable data={[key]} loading={false} isLoadingKey={() => false} onRevoke={vi.fn()} />),
    )
    expect(document.body.textContent).toContain('read:audit_logs')
    expect(document.body.textContent).toContain('No expiration')
  })
})
