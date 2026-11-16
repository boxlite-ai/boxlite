// Local screenshot harness. Production components; MSW account data; official Turnstile test key.
import { http, HttpResponse, delay } from 'msw'
import { worker } from '../../src/mocks/browser'
import { buildMockConfig, MOCK_USER, MOCK_ORGANIZATION } from '../../src/mocks/fixtures'
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'verify'
const api = import.meta.env.VITE_API_URL
let registered = ['prepare', 'error', 'welcome'].includes(scenario)
let reads = 0
worker.use(
  http.get(`${api}/config`, () =>
    HttpResponse.json({
      ...buildMockConfig(`${location.origin}/api/billing`),
      turnstile: { sitekey: '1x00000000000000000000AA', action: 'signup' },
    }),
  ),
  http.get(`${api}/users/me`, async () => {
    await delay(scenario === 'confirm' && registered ? 8000 : 200)
    return registered
      ? HttpResponse.json({ id: MOCK_USER.sub, name: MOCK_USER.name })
      : HttpResponse.json(
          { code: 'registration_required', message: 'Complete registration to continue' },
          { status: 403 },
        )
  }),
  http.post(`${api}/auth/register`, async () => {
    await delay(500)
    registered = true
    return HttpResponse.json({ id: MOCK_USER.sub })
  }),
  http.get(`${api}/organizations`, () => HttpResponse.json([MOCK_ORGANIZATION])),
  http.get(`${api}/box/paginated`, async () => {
    await delay(scenario === 'prepare' ? 8000 : 700)
    if (scenario === 'error' && reads++ === 0) return HttpResponse.json({ message: 'Unavailable' }, { status: 503 })
    return HttpResponse.json({ items: [], total: 0, page: 1, totalPages: 0 })
  }),
  http.get(`${api}/api-keys`, () => HttpResponse.json([])),
)
history.replaceState({}, '', scenario === 'welcome' ? '/dashboard/welcome' : '/dashboard/boxes')
void import('../../src/main')
