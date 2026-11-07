/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { ExecutionLease, ExecutionScope, GitHubAppSource } from '@boxlite-ai/ci-listener'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'
import { CiNativeHost } from './ci-native-host'
import { CiNativeState } from './ci-native-state'

const database = process.env.CI_CONNECT_TEST_DATABASE_URL
const integration = database ? describe : describe.skip
integration('CI managed organization group (real Postgres)', () => {
  const schema = 'ci_group_' + randomUUID().replaceAll('-', ''),
    organization = randomUUID(),
    binding = randomUUID(),
    actor = 'group-owner',
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    originalFetch = global.fetch,
    repositories = [21, 22].map((id) => ({
      id,
      name: 'repo' + id,
      private: id === 21,
      owner: { id: 7, login: 'owner' },
    })),
    config = { get: (key: string) => ({ 'ci.githubClientId': 'personal-app', 'ci.githubOrgClientId': 'org-app' })[key] }
  let db: DataSource,
    store: CiNativeState,
    host: CiNativeHost,
    lease: ExecutionLease,
    group: Record<string, unknown>,
    selected: number[],
    mutations: string[],
    beforeGroupRead: (() => Promise<void>) | undefined,
    reports: jest.SpyInstance
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(database!).hostname))
      throw Error('Disposable database required')
    db = await new DataSource({
      type: 'postgres',
      url: database,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE ci_installation_binding(id uuid PRIMARY KEY,generation bigint,github_host text,app_client_id text,
      installation_id bigint,account_id bigint,account_login text,account_type text,organization_id uuid,
      actor_id text,allow_public boolean,follow_installation boolean,state text);
      CREATE TABLE "user"(id text PRIMARY KEY,role text);
      CREATE TABLE organization_user("organizationId" uuid,"userId" text,role text)`)
    const runner = db.createQueryRunner()
    try {
      await new AddCiListenerState1793700000000().up(runner)
    } finally {
      await runner.release()
    }
  })
  afterAll(async () => {
    if (db?.isInitialized)
      try {
        await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await db.destroy()
      }
  })
  beforeEach(async () => {
    await db.query('TRUNCATE ci_listener_state,ci_installation_binding,"user",organization_user')
    await db.query(
      `INSERT INTO ci_installation_binding VALUES($1,1,'github.com','org-app',1,7,'owner','Organization',$2,$3,false,true,'provisioning')`,
      [binding, organization, actor],
    )
    await db.query('INSERT INTO "user" VALUES($1,\'user\')', [actor])
    await db.query("INSERT INTO organization_user VALUES($1,$2,'owner')", [organization, actor])
    store = new CiNativeState(db, config as any)
    await store.initialize()
    lease = (await store.state.acquire(randomUUID(), 300000))!
    const app = new GitHubAppSource({ issuer: 'org-app', privateKey: () => privateKey })
    host = new CiNativeHost(
      db,
      store,
      {} as any,
      {
        byClientId: () => ({
          appSource: () => app,
          secret: () => {
            throw Error('Webhook disabled')
          },
        }),
      } as any,
      config as any,
    )
    reports = jest.spyOn(host, 'report').mockImplementation(() => {})
    group = {
      id: 5,
      name: 'boxlite-ci-runner',
      default: false,
      inherited: false,
      visibility: 'selected',
      restricted_to_workflows: false,
      allows_public_repositories: true,
    }
    selected = [21, 22]
    mutations = []
    beforeGroupRead = undefined
    global.fetch = jest.fn(async (input, options) => {
      const url = new URL(String(input)),
        path = url.pathname,
        method = options?.method || 'GET',
        body = options?.body ? JSON.parse(String(options.body)) : undefined,
        json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (path === '/app/installations/1')
        return json({
          id: 1,
          account: { id: 7, login: 'owner', type: 'Organization' },
          suspended_at: null,
          permissions: { metadata: 'read', actions: 'read', organization_self_hosted_runners: 'write' },
        })
      if (path.endsWith('/access_tokens'))
        return json(
          {
            token: 'test-group-token',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { ...body.permissions, metadata: 'read' },
          },
          201,
        )
      if (path === '/installation/token') return new Response(null, { status: 204 })
      if (path === '/installation/repositories') return json({ total_count: 2, repositories })
      if (path === '/orgs/owner/actions/runner-groups') {
        const hook = beforeGroupRead
        beforeGroupRead = undefined
        await hook?.()
        return json({ total_count: 1, runner_groups: [group] })
      }
      if (method === 'PATCH' || method === 'PUT') {
        const [intent] = await store.state.read(['group-sync/1'])
        expect(intent?.payload).toMatchObject({ binding, application: 'org-app', effect: { method, path, body } })
        mutations.push(method)
        if (method === 'PATCH') {
          Object.assign(group, body)
          return json(group)
        }
        selected = body.selected_repository_ids
        return new Response(null, { status: 204 })
      }
      if (path === '/orgs/owner/actions/runner-groups/5') return json(group)
      if (path.endsWith('/5/repositories'))
        return json({
          total_count: selected.length,
          repositories: repositories.filter((repository) => selected.includes(repository.id)),
        })
      throw Error('Unexpected group fixture request')
    }) as typeof fetch
  })
  afterEach(async () => {
    await host.close()
    global.fetch = originalFetch
    reports.mockRestore()
  })
  async function discover(
    until: (view: { scopes: ExecutionScope[]; ready: boolean }) => boolean = (view) => view.ready,
  ) {
    const signal = AbortSignal.timeout(5000)
    let refresh = true
    while (!signal.aborted) {
      const view = await host.discover(lease, signal, { refresh, wakes: [] })
      refresh = false
      if (until(view)) return view
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw Error('Group directory did not reach the observed boundary')
  }
  it('journals authorized group writes and marks ready only after synchronization', async () => {
    const view = await discover((value) => value.ready || reports.mock.calls.length > 0)
    expect(view.scopes).toHaveLength(1)
    expect(reports).not.toHaveBeenCalled()
    expect(view.scopes[0].runners).toMatchObject({ repositories: [21], allowPublic: false })
    expect(mutations).toEqual(['PATCH', 'PUT'])
    expect((await db.query('SELECT state FROM ci_installation_binding'))[0].state).toBe('ready')
    await db.query("UPDATE ci_installation_binding SET allow_public=true,generation=2,state='provisioning'")
    const expanded = await discover()
    expect(expanded.scopes[0].runners).toMatchObject({ repositories: [21, 22], allowPublic: true })
    expect(selected).toEqual([21, 22])
    expect(group.allows_public_repositories).toBe(true)
    expect(await db.query('SELECT id FROM ci_installation_binding')).toEqual([{ id: binding }])
  })
  it.each(['owner', 'generation', 'disabled', 'root', 'lease'])(
    'refuses writes after %s authority changes during inventory reads',
    async (kind) => {
      beforeGroupRead = async () => {
        if (kind === 'owner') await db.query('DELETE FROM organization_user')
        if (kind === 'generation') await db.query('UPDATE ci_installation_binding SET generation=2')
        if (kind === 'disabled') await db.query("UPDATE ci_installation_binding SET state='disabled'")
        if (kind === 'root')
          await db.query("UPDATE ci_listener_state SET payload='{}'::jsonb WHERE record_key='backend/native'")
        if (kind === 'lease')
          await db.query(
            "UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0'::jsonb) WHERE record_key='@owner'",
          )
      }
      const view = await discover((value) => value.ready || reports.mock.calls.length > 0).catch((error) => {
        if (kind !== 'lease') throw error
        return { scopes: [], ready: false }
      })
      expect(view.scopes).toEqual([])
      expect(mutations).toEqual([])
      expect(await store.state.read(['group-sync/1'])).toEqual([])
      expect((await db.query('SELECT state FROM ci_installation_binding'))[0].state).not.toBe('ready')
    },
  )
})
