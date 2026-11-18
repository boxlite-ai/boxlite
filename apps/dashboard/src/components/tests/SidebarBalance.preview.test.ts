import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const origin = 'https://billing-preview.test'
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})
describe('SidebarBalance new-user preview', () => {
  it.each(['new-user', 'new-user-unfunded'])('keeps %s fleet and CI empty across navigation', async (preview) => {
    const location = { origin, search: `?preview=${preview}` }
    vi.stubGlobal('window', { location })
    vi.stubEnv('VITE_API_URL', `${origin}/api`)
    const { handlers } = await import('@/mocks/handlers')
    const { MOCK_ORGANIZATION } = await import('@/mocks/fixtures')
    server.use(...handlers)
    expect(await (await fetch(`${origin}/api/box/paginated`)).json()).toMatchObject({ items: [], total: 0 })
    location.search = ''
    const runners = await fetch(`${origin}/v1/${MOCK_ORGANIZATION.id}/ci/runners`)
    expect(await runners.json()).toMatchObject({ items: [], total: 0, capacity: { used: 0 } })
  })
  it.each(['created', 'published'])('retains a complete Quickstart handoff Box in %s state', async (stage) => {
    vi.stubGlobal('window', { location: { origin, search: '?preview=new-user' } })
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'qs-publish-demo' ? stage : null) })
    vi.stubEnv('VITE_API_URL', `${origin}/api`)
    const { handlers } = await import('@/mocks/handlers')
    const { MOCK_ORGANIZATION } = await import('@/mocks/fixtures')
    server.use(...handlers)
    const box = await (await fetch(`${origin}/api/box/mock-box-agent`)).json()
    expect(box).toMatchObject({ id: 'mock-box-agent', organizationId: MOCK_ORGANIZATION.id, state: 'started' })
    expect(box.image).toBeTruthy()
    expect(box.cpu).toBeGreaterThan(0)
    expect(box.network.inbound.mode).toBe(stage === 'published' ? 'enabled' : 'disabled')
  })
})
