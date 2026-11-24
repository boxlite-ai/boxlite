import { sha256hex } from '../auth'
import type { Ctx } from '../ctx'
import { HttpError } from '../errors'
import { Resources } from '../resources'
import { svRoutes } from './sv'

const app = { id: 'app', name: 'test-app', org_id: 'org' }
const secret = 'synthetic-app-secret'
const database = 'postgres://synthetic.invalid/test'

function fixture() {
  const deployment = {
    number: 1,
    kind: 'deploy',
    status: 'building',
    built: false,
    legacy_source: 'authorized',
    box_id: 'box',
    spec_version: 1,
    snapshot_id: 'snapshot',
  }
  const env = {
    id: 'env',
    app_id: app.id,
    name: 'main',
    active_box_id: 'box',
    requested_deployment: 1,
    live_deployment: null as number | null,
    db_url: database,
    forward_secret: '',
    control_secret: '',
  }
  const spec = {
    version: 1,
    deployment: 1,
    database: { migrations: 'migrations', applied: [] },
    variables: { THEME: 'light' },
    secrets: { APP_TOKEN: 'app/test-secret' },
    runtime: { image: 'node', size: 'small' },
    volumes: [],
  }
  const provisioning = { box_image: 'node', box_size: 'small', box_volumes: '' }
  const store = {
    get: jest.fn(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('JOIN box b')) return params[4] === sha256hex('synthetic-box') ? provisioning : undefined
      if (sql.includes('box_tokens')) return { env_id: env.id }
      if (sql.includes('app_secrets')) return { value: secret }
      return undefined
    }),
    envById: async () => env,
    appById: async () => app,
    appByNameAnyState: async () => app,
    envByName: async () => env,
    deployment: async () => deployment,
    spec: async () => spec,
  }
  const ctx = {
    store,
    config: { supervisorUrl: 'https://supervisor.example.test' },
    origins: { envUrl: async () => 'https://app.example.test' },
  } as unknown as Ctx
  ctx.resources = new Resources(ctx)
  const routes = svRoutes(ctx)
  routes.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.toBody(), err.status as 400)
    throw err
  })
  function rawRequest(query: string, token = 'synthetic-box') {
    return routes.request(`/v1/spec${query}`, { headers: { authorization: `Bearer ${token}` } })
  }
  async function request(query = '') {
    const response = await rawRequest(query)
    expect(response.status).toBe(200)
    return (await response.json()) as { env: Record<string, string>; deployment: number | null; snapshot: unknown }
  }
  return { deployment, env, provisioning, rawRequest, request }
}

test.each(['', '?phase=build'])(
  'build Spec keeps ordinary variables and excludes runtime credentials (%s)',
  async (query) => {
    const response = await fixture().request(query)
    expect(response.env.THEME).toBe('light')
    expect(Object.hasOwn(response.env, 'APP_TOKEN')).toBe(false)
    expect(Object.hasOwn(response.env, 'DATABASE_URL')).toBe(false)
    expect(response.snapshot).not.toBeNull()
  },
)

test('legacy activation gets runtime credentials without a boot rebuild target', async () => {
  const { deployment, request } = fixture()
  deployment.status = 'starting'
  deployment.built = true
  const response = await request()
  expect(response.env.THEME).toBe('light')
  expect(response.env.APP_TOKEN === secret).toBe(true)
  expect(response.env.DATABASE_URL === database).toBe(true)
  expect(response.deployment).toBeNull()
  expect(response.snapshot).toBeNull()
})

test('settled legacy Spec has no rebuild target or runtime credentials', async () => {
  const { env, request } = fixture()
  env.live_deployment = env.requested_deployment
  const response = await request()
  expect(response).toMatchObject({ deployment: null, snapshot: null, spec: { version: 1 } })
  expect(Object.hasOwn(response.env, 'APP_TOKEN')).toBe(false)
  expect(Object.hasOwn(response.env, 'DATABASE_URL')).toBe(false)
})

test('an in-flight legacy deployment without source authorization gets a conflict', async () => {
  const { deployment, rawRequest } = fixture()
  deployment.legacy_source = 'read'
  const response = await rawRequest('')
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'legacy_spec_pending' } })
})

test.each(['build', 'runtime'])('recovery %s checks the Box, token, provisioning and pinned Spec', async (phase) => {
  const { env, provisioning, rawRequest } = fixture()
  env.live_deployment = env.requested_deployment
  const query = `?phase=${phase}&operation=1&version=1&box=box`
  expect((await rawRequest(query, 'newly-issued-box-token')).status).toBe(409)
  expect((await rawRequest(query.replace('version=1', 'version=2'))).status).toBe(409)
  expect((await rawRequest(query.replace('box=box', 'box=previous'))).status).toBe(409)
  provisioning.box_size = 'large'
  expect((await rawRequest(query)).status).toBe(409)
  provisioning.box_size = 'small'
  const response = await rawRequest(query)
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.deployment).toBe(1)
  expect(result.env.THEME).toBe('light')
  expect(Object.hasOwn(result.env, 'APP_TOKEN')).toBe(phase === 'runtime')
  expect(Object.hasOwn(result.env, 'DATABASE_URL')).toBe(phase === 'runtime')
  expect(result.snapshot !== null).toBe(phase === 'build')
})
