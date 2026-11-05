// @vitest-environment jsdom
import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apiKeyHandlers } from './api-key-handlers'

vi.hoisted(() => vi.stubEnv('VITE_API_URL', 'https://keys-preview.example.test/api'))
const server = setupServer(...apiKeyHandlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

describe('API key mock permissions', () => {
  async function create(name: string, permissions?: string[]) {
    const response = await fetch('https://keys-preview.example.test/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BoxLite-Organization-ID': 'key-preview-org' },
      body: JSON.stringify({ name, permissions }),
    })
    expect(response.status).toBe(201)
    return response.json()
  }

  it('grants all supported permissions when the request omits them', async () => {
    const created = await create('default-permissions')
    const permissions = Object.values(CreateApiKeyPermissionsEnum).filter(
      (permission) => permission !== CreateApiKeyPermissionsEnum.UNKNOWN_DEFAULT_OPEN_API,
    )
    expect(created.permissions).toEqual(permissions)
  })

  it.each([{ permissions: [] }, { permissions: ['read:apps'] }])(
    'preserves an explicit permission list $permissions',
    async ({ permissions }) => {
      const created = await create(`explicit-${permissions.length}`, permissions)
      expect(created.permissions).toEqual(permissions)
    },
  )
})
