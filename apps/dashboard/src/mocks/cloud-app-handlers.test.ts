// @vitest-environment jsdom
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/apiClient'
import type { AppDetail, AppSummary, CreatedApp } from '@/lib/apps/types'
import type { DashboardConfig } from '@/types/DashboardConfig'
import { handlers } from './handlers'
import { MOCK_ORGANIZATION_ID } from './fixtures'

vi.hoisted(() => vi.stubEnv('VITE_API_URL', 'https://preview.example.test/api'))
const server = setupServer(...handlers)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

describe('Apps mock preview', () => {
  const client = new ApiClient(
    { apiUrl: 'https://preview.example.test/api' } as DashboardConfig,
    'mock-access-token',
  ).cloudApps(MOCK_ORGANIZATION_ID)

  it('loads an App list and its detail through the shared organization client', async () => {
    const { data: apps } = await client.get<AppSummary[]>('/apps')
    expect(apps.some((app) => app.status === 'live')).toBe(true)
    expect(apps.some((app) => app.status === 'draft')).toBe(true)
    const { data: app } = await client.get<AppDetail>(`/apps/${apps[0].id}/view`)
    expect(app.id).toBe(apps[0].id)
    expect(app.environment).toBe('main')
    expect(app.services.length).toBeGreaterThan(0)
  })

  it('creates a draft and returns it in the list without issuing credentials', async () => {
    const { data } = await client.post<CreatedApp>('/apps', { name: 'preview-created' })
    expect(data.app.status).toBe('draft')
    expect(data.app.handoffPrompt).toContain('preview-created')
    expect(data).not.toHaveProperty('key')
    const { data: apps } = await client.get<AppSummary[]>('/apps')
    expect(apps.some((app) => app.id === data.app.id)).toBe(true)
  })
})
