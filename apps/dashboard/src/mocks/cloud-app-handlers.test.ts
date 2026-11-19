// @vitest-environment jsdom
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/apiClient'
import type { AppDetail, AppSummary, CreatedApp, DeletedApp } from '@/lib/apps/types'
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

  it('deletes starter into Recently deleted and restores its draft configuration', async () => {
    const { data: starter } = await client.get<AppDetail>('/apps/starter/view')
    expect(starter.status).toBe('draft')

    const deletion = await client.delete('/apps/starter')
    expect(deletion.status).toBe(204)
    const { data: remaining } = await client.get<AppSummary[]>('/apps')
    expect(remaining.some((app) => app.id === starter.id)).toBe(false)
    await expect(client.get('/apps/starter/view')).rejects.toMatchObject({ cause: { response: { status: 404 } } })

    const { data: deleted } = await client.get<DeletedApp[]>('/apps/deleted')
    const retained = deleted.find((app) => app.name === starter.name)
    expect(retained).toMatchObject({ name: starter.name, environments: 1 })
    expect(Number.isFinite(Date.parse(retained!.deletedAt))).toBe(true)
    expect(Date.parse(retained!.purgeAfter) - Date.parse(retained!.deletedAt)).toBe(7 * 86_400_000)
    await expect(client.post('/apps', { name: starter.name })).rejects.toMatchObject({
      cause: { response: { status: 409 } },
    })

    const { data: restored } = await client.post<AppSummary>('/apps/deleted/starter/restore')
    expect(restored).toMatchObject({ id: starter.id, name: starter.name, status: 'draft', environments: 1 })
    const { data: detail } = await client.get<AppDetail>('/apps/starter/view')
    expect(detail).toEqual(starter)
    const { data: active } = await client.get<AppSummary[]>('/apps')
    expect(active.some((app) => app.id === starter.id)).toBe(true)
    const { data: afterRestore } = await client.get<DeletedApp[]>('/apps/deleted')
    expect(afterRestore.some((app) => app.name === starter.name)).toBe(false)
  })

  it('returns not found when deleting or restoring a missing App', async () => {
    for (const request of [
      () => client.delete('/apps/absent-preview-app'),
      () => client.post('/apps/deleted/absent-preview-app/restore'),
    ]) {
      await expect(request()).rejects.toMatchObject({ cause: { response: { status: 404 } } })
    }
  })
})
