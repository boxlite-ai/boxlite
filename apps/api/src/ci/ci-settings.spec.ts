/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { ExecutionJournal, ExecutionScope, LeaseLost, StateConflict, StateCorrupt } from '@boxlite-ai/ci-listener'
import { AddCiConnect1793664000000 } from '../migrations/pre-deploy/1793664000000-add-ci-connect-migration'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'
import { BoxState } from '../box/enums/box-state.enum'
import { CiSettingsService } from './ci-settings.service'
import { CiNativeState } from './ci-native-state'

const url = process.env.CI_CONNECT_TEST_DATABASE_URL
const integration = url ? describe : describe.skip
integration('CI account settings (real Postgres)', () => {
  const schema = 'ci_settings_' + randomUUID().replaceAll('-', '')
  const org = randomUUID(),
    otherOrg = randomUUID(),
    binding = randomUUID()
  const actor = { organizationId: org, userId: 'owner' }
  const commerce = { resolveMaxCreatedBoxes: jest.fn<Promise<number | undefined>, [string]>() }
  let db: DataSource, native: CiNativeState, settings: CiSettingsService
  const policyKey = (id = org) => 'quota/' + id
  const scope = (): ExecutionScope => ({
    binding,
    generation: 1,
    organization: org,
    actor: 'owner',
    installation: { id: 10, account: { id: 20, login: 'owner', type: 'User' } },
    runners: {
      kind: 'repository',
      allowPublic: false,
      repository: { id: 30, name: 'repo', private: true, owner: { id: 20, login: 'owner' } },
    },
  })
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
      throw Error('Disposable local database required')
    db = await new DataSource({
      type: 'postgres',
      url,
      entities: [],
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE organization(id uuid PRIMARY KEY);
      CREATE TABLE "user"(id text PRIMARY KEY,role text NOT NULL);
      CREATE TABLE organization_user("organizationId" uuid,"userId" text,role text);
      CREATE TABLE api_key("keyHash" text PRIMARY KEY,"organizationId" uuid,"userId" text,permissions text[],"expiresAt" timestamptz);
      CREATE TABLE box(id uuid PRIMARY KEY,"organizationId" uuid,state text NOT NULL)`)
    const runner = db.createQueryRunner()
    try {
      await new AddCiConnect1793664000000().up(runner)
      await new AddCiListenerState1793700000000().up(runner)
    } finally {
      await runner.release()
    }
    await db.query('INSERT INTO organization VALUES($1),($2)', [org, otherOrg])
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
    await db.query(
      'TRUNCATE ci_connect_attempt,ci_installation_binding,ci_listener_state,organization_user,"user",api_key,box',
    )
    await db.query("INSERT INTO \"user\" VALUES('owner','user'),('other-owner','user'),('admin','admin')")
    await db.query("INSERT INTO organization_user VALUES($1,'owner','owner'),($2,'other-owner','owner')", [
      org,
      otherOrg,
    ])
    commerce.resolveMaxCreatedBoxes.mockReset().mockResolvedValue(5)
    native = new CiNativeState(db, {
      get: (key: string) => (key === 'ci.githubClientId' ? 'test-app' : undefined),
    } as any)
    await native.initialize()
    settings = new CiSettingsService(native, commerce as any)
    await settings.initialize()
  })
  async function connect(id = org, installation = 10, account = 20, login = 'owner') {
    // Existing connect producers use this same binding schema; quota creation is exercised through its service.
    await native.transaction(async (tx) => {
      await settings.ensure(tx, id)
      await tx.query(
        `INSERT INTO ci_installation_binding
        (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation,allow_public,state)
        VALUES($1,'github.com','test-app',$2,$3,$4,'User',$5,$6,true,false,'ready')`,
        [
          installation === 10 ? binding : randomUUID(),
          installation,
          account,
          login,
          id,
          id === org ? 'owner' : 'other-owner',
        ],
      )
    })
  }
  async function resetActivation() {
    await db.query("DELETE FROM ci_listener_state WHERE namespace=$1 AND record_key='quota/bootstrap'", [
      native.namespace,
    ])
    await db.query(
      "UPDATE ci_listener_state SET payload=payload-'quotaVersion' WHERE namespace=$1 AND record_key='backend/native'",
      [native.namespace],
    )
  }
  it('inherits Commerce by default, accepts an account override and restores the default', async () => {
    expect(await settings.get(actor)).toMatchObject({
      max_concurrent_jobs: null,
      commerce_limit: 5,
      effective_limit: 5,
    })
    expect(await settings.update(actor, 2)).toMatchObject({ max_concurrent_jobs: 2, effective_limit: 2 })
    expect(await settings.get(actor)).toMatchObject({ max_concurrent_jobs: 2, effective_limit: 2 })
    expect(await settings.update(actor, null)).toMatchObject({ max_concurrent_jobs: null, effective_limit: 5 })
  })
  it('rejects values above Commerce, negative values and unsafe numbers without saving them', async () => {
    for (const value of [6, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await expect(settings.update(actor, value)).rejects.toBeInstanceOf(BadRequestException)
    expect(await native.state.read([policyKey()])).toEqual([])
  })
  it('preserves zero and an unlimited Commerce response rather than substituting one', async () => {
    commerce.resolveMaxCreatedBoxes.mockResolvedValue(0)
    expect(await settings.get(actor)).toMatchObject({ effective_limit: 0 })
    await expect(settings.update(actor, 1)).rejects.toBeInstanceOf(BadRequestException)
    commerce.resolveMaxCreatedBoxes.mockResolvedValue(undefined)
    expect(await settings.get(actor)).toMatchObject({ effective_limit: null })
    expect(await settings.update(actor, 20)).toMatchObject({ effective_limit: 20 })
  })
  it('clamps an existing override when Commerce later lowers the account allowance', async () => {
    await settings.update(actor, 4)
    commerce.resolveMaxCreatedBoxes.mockResolvedValue(2)
    expect(await settings.get(actor)).toMatchObject({ max_concurrent_jobs: 4, effective_limit: 2 })
  })
  it('isolates connections and settings by the authenticated BoxLite account', async () => {
    await connect()
    await connect(otherOrg, 11, 21, 'other')
    expect((await settings.get(actor)).connections.map((x) => x.github_account)).toEqual(['owner'])
    expect(
      (await settings.get({ organizationId: otherOrg, userId: 'other-owner' })).connections.map(
        (x) => x.github_account,
      ),
    ).toEqual(['other'])
    await expect(settings.update({ ...actor, organizationId: otherOrg }, 2)).rejects.toBeInstanceOf(ForbiddenException)
    expect((await settings.get({ organizationId: otherOrg, userId: 'other-owner' })).max_concurrent_jobs).toBeNull()
  })
  it('rechecks the current owner and exact delegated Key permissions', async () => {
    await db.query('UPDATE organization_user SET role=\'member\' WHERE "organizationId"=$1', [org])
    await expect(settings.update(actor, 2)).rejects.toBeInstanceOf(ForbiddenException)
    await db.query('UPDATE organization_user SET role=\'owner\' WHERE "organizationId"=$1', [org])
    const hash = 'a'.repeat(64)
    await db.query('INSERT INTO api_key VALUES($1,$2,$3,$4,NULL)', [hash, org, 'owner', ['write:boxes']])
    await expect(settings.update({ ...actor, apiKey: { keyHash: hash } }, 2)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(settings.update({ ...actor, apiKey: { keyHash: 'b'.repeat(64) } }, 2)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(await native.state.read([policyKey()])).toEqual([])
  })
  it('rolls back settings when a Key expires while the policy write is waiting', async () => {
    await settings.update(actor, 2)
    const [before] = await native.state.read([policyKey()]),
      hash = 'c'.repeat(64)
    await db.query(`INSERT INTO api_key VALUES($1,$2,$3,$4,clock_timestamp()+interval '100 milliseconds')`, [
      hash,
      org,
      'owner',
      ['write:boxes', 'delete:boxes'],
    ])
    await db.query(`CREATE FUNCTION delay_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.record_key LIKE 'quota/%' THEN PERFORM pg_sleep(0.2); END IF; RETURN NEW; END $$;
      CREATE TRIGGER delay_policy BEFORE UPDATE ON ci_listener_state FOR EACH ROW EXECUTE FUNCTION delay_policy()`)
    try {
      await expect(settings.update({ ...actor, apiKey: { keyHash: hash } }, 1)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    } finally {
      await db.query('DROP TRIGGER delay_policy ON ci_listener_state; DROP FUNCTION delay_policy()')
    }
    expect(await native.state.read([policyKey()])).toEqual([before])
  })
  it('rejects an expired Key even when the hosted feature is unavailable', async () => {
    const hash = 'd'.repeat(64)
    await db.query(`INSERT INTO api_key VALUES($1,$2,$3,$4,clock_timestamp()-interval '1 second')`, [
      hash,
      org,
      'owner',
      ['write:boxes', 'delete:boxes'],
    ])
    const unavailable = new CiSettingsService(new CiNativeState(db, { get: () => undefined } as any), commerce as any)
    await expect(unavailable.get({ ...actor, apiKey: { keyHash: hash } })).rejects.toBeInstanceOf(ForbiddenException)
  })
  it('keeps current-format settings through repeated first activation and never overwrites an override', async () => {
    await connect()
    await settings.update(actor, 2)
    await resetActivation()
    await settings.initialize()
    await settings.initialize()
    expect((await settings.get(actor)).max_concurrent_jobs).toBe(2)
  })
  it('rolls back an interrupted first activation and safely resumes it', async () => {
    await connect()
    await resetActivation()
    await db.query('DELETE FROM ci_listener_state WHERE namespace=$1 AND record_key=$2', [
      native.namespace,
      policyKey(),
    ])
    await db.query(`CREATE FUNCTION stop_quota_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.record_key='quota/bootstrap' THEN RAISE EXCEPTION 'bootstrap test interruption'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER stop_quota_bootstrap BEFORE INSERT ON ci_listener_state FOR EACH ROW EXECUTE FUNCTION stop_quota_bootstrap()`)
    try {
      await expect(settings.initialize()).rejects.toThrow('bootstrap test interruption')
    } finally {
      await db.query('DROP TRIGGER stop_quota_bootstrap ON ci_listener_state; DROP FUNCTION stop_quota_bootstrap()')
    }
    expect(await native.state.read([policyKey()])).toEqual([])
    await settings.initialize()
    expect((await settings.get(actor)).max_concurrent_jobs).toBeNull()
  })
  it('does not silently recreate a connected account quota after activation', async () => {
    await connect()
    await db.query('DELETE FROM ci_listener_state WHERE namespace=$1 AND record_key=$2', [
      native.namespace,
      policyKey(),
    ])
    await settings.initialize()
    await expect(settings.get(actor)).rejects.toBeInstanceOf(StateCorrupt)
    await expect(settings.update(actor, null)).rejects.toBeInstanceOf(StateCorrupt)
  })
  it('rejects a deleted bootstrap marker after completion instead of initializing again', async () => {
    await db.query("DELETE FROM ci_listener_state WHERE namespace=$1 AND record_key='quota/bootstrap'", [
      native.namespace,
    ])
    await expect(settings.initialize()).rejects.toBeInstanceOf(StateCorrupt)
  })
  it('uses one tenant budget for different installations and fences a later downgrade', async () => {
    await connect()
    await connect(org, 11, 21, 'other')
    const journal = new ExecutionJournal(native.state),
      lease = (await native.state.acquire(randomUUID(), 30000))!
    const key = await native.applications().define(lease, scope(), 'test-app')
    const budget = await settings.resolve({
      scope: scope(),
      repository: 30,
      lease,
      signal: new AbortController().signal,
    })
    expect(budget.limits.map((limit) => limit.maximum)).toEqual([5])
    expect(budget.checks).toHaveLength(2)
    await settings.update(actor, 0)
    await expect(journal.reserve(lease, key, { repository: 30, run: 40, job: 50 }, budget)).rejects.toBeInstanceOf(
      StateConflict,
    )
    expect((await journal.load(lease)).allocations.size).toBe(0)
  })
  it('rejects capacity lookup after owner revocation or an original binding identity change', async () => {
    await connect()
    const lease = (await native.state.acquire(randomUUID(), 30000))!
    const resolve = (original: ExecutionScope) =>
      settings.resolve({ scope: original, repository: 30, lease, signal: new AbortController().signal })
    await expect(resolve({ ...scope(), organization: otherOrg })).rejects.toBeInstanceOf(ForbiddenException)
    await expect(resolve({ ...scope(), generation: 2 })).rejects.toBeInstanceOf(ForbiddenException)
    await db.query('DELETE FROM organization_user WHERE "organizationId"=$1', [org])
    await expect(resolve(scope())).rejects.toBeInstanceOf(ForbiddenException)
    expect((await native.state.read(['catalog/scopes']))[0].payload).toEqual({ keys: [] })
  })
  it('rejects a stale scheduling lease and a missing permanent policy', async () => {
    await connect()
    const lease = (await native.state.acquire(randomUUID(), 30000))!
    await native.applications().define(lease, scope(), 'test-app')
    const request = { scope: scope(), repository: 30, lease, signal: new AbortController().signal }
    await expect(settings.resolve({ ...request, lease: { ...lease, epoch: lease.epoch + 1 } })).rejects.toBeInstanceOf(
      LeaseLost,
    )
    await db.query('DELETE FROM ci_listener_state WHERE namespace=$1 AND record_key=$2', [
      native.namespace,
      policyKey(),
    ])
    await expect(settings.resolve(request)).rejects.toBeInstanceOf(StateCorrupt)
  })
  it('returns no policy while Commerce is unavailable or the lookup is aborted', async () => {
    await connect()
    const lease = (await native.state.acquire(randomUUID(), 30000))!
    await native.applications().define(lease, scope(), 'test-app')
    const request = { scope: scope(), repository: 30, lease, signal: new AbortController().signal }
    commerce.resolveMaxCreatedBoxes.mockRejectedValueOnce(Error('Commerce unavailable'))
    await expect(settings.resolve(request)).rejects.toThrow('Commerce unavailable')
    await expect(settings.resolve({ ...request, signal: AbortSignal.abort() })).rejects.toThrow()
    expect((await new ExecutionJournal(native.state).load(lease)).allocations.size).toBe(0)
  })
  it('enforces the hosted account total across installations while leaving another account independent', async () => {
    await connect()
    await connect(org, 11, 21, 'other')
    await connect(otherOrg, 12, 22, 'third')
    await settings.update(actor, 1)
    const lease = (await native.state.acquire(randomUUID(), 30000))!
    const journal = new ExecutionJournal(native.state)
    const reserve = async (original: ExecutionScope) => {
      await native.applications().define(lease, original, 'test-app')
      const repository = original.runners.kind === 'repository' ? original.runners.repository.id : 0
      const policy = await settings.resolve({
        scope: original,
        repository,
        lease,
        signal: new AbortController().signal,
      })
      return journal.reserve(
        lease,
        await journal.define(lease, original),
        { repository, run: 40, job: repository },
        policy,
      )
    }
    expect(await reserve(scope())).toBeDefined()
    const makeScope = async (
      installation: number,
      organization: string,
      actor: string,
      account: number,
      login: string,
    ): Promise<ExecutionScope> => {
      const [row] = await db.query('SELECT id FROM ci_installation_binding WHERE installation_id=$1', [installation])
      return {
        ...scope(),
        binding: row.id,
        organization,
        actor,
        installation: { id: installation, account: { id: account, login, type: 'User' } },
        runners: {
          kind: 'repository',
          allowPublic: false,
          repository: { id: installation + 30, name: 'repo', owner: { id: account, login }, private: true },
        },
      }
    }
    expect(await reserve(await makeScope(11, org, 'owner', 21, 'other'))).toBeUndefined()
    expect(await reserve(await makeScope(12, otherOrg, 'other-owner', 22, 'third'))).toBeDefined()
    expect((await journal.load(lease)).workers).toHaveLength(2)
  })
  it('keeps Personal and Organization Apps under one native namespace and one account quota', async () => {
    await connect()
    await connect(org, 11, 21, 'team')
    await db.query(
      "UPDATE ci_installation_binding SET app_client_id='org-app',account_type='Organization' WHERE installation_id=11",
    )
    const config = {
      get: (key: string) => ({ 'ci.githubClientId': 'test-app', 'ci.githubOrgClientId': 'org-app' })[key],
    }
    native = new CiNativeState(db, config as any)
    await native.initialize()
    settings = new CiSettingsService(native, commerce as any)
    await settings.initialize()
    await settings.update(actor, 1)
    const lease = (await native.state.acquire(randomUUID(), 30000))!,
      journal = new ExecutionJournal(native.state)
    const [binding] = await db.query('SELECT id FROM ci_installation_binding WHERE installation_id=11')
    const organization: ExecutionScope = {
      ...scope(),
      binding: binding.id,
      installation: { id: 11, account: { id: 21, login: 'team', type: 'Organization' } },
      runners: {
        kind: 'organization',
        account: { id: 21, login: 'team' },
        group: 9,
        repositories: [31],
        allowPublic: false,
      },
    }
    const first = await native.applications().define(lease, scope(), 'test-app')
    const second = await native.applications().define(lease, organization, 'org-app')
    const reserve = async (original: ExecutionScope, key: string, repository: number) => {
      const policy = await settings.resolve({
        scope: original,
        repository,
        lease,
        signal: new AbortController().signal,
      })
      return journal.reserve(lease, key, { repository, run: 40, job: repository }, policy)
    }
    expect(await reserve(scope(), first, 30)).toBeDefined()
    expect(await reserve(organization, second, 31)).toBeUndefined()
    expect((await settings.get(actor)).connections).toHaveLength(2)
    expect((await journal.load(lease)).workers).toHaveLength(1)
  })
  it('waits when ordinary created Boxes occupy Commerce capacity, and resumes after one is removed', async () => {
    await connect()
    const lease = (await native.state.acquire(randomUUID(), 30000))!
    await native.applications().define(lease, scope(), 'test-app')
    const ids = Array.from({ length: 5 }, () => randomUUID())
    for (const id of ids) await db.query('INSERT INTO box VALUES($1,$2,$3)', [id, org, BoxState.STOPPED])
    expect(
      (await settings.resolve({ scope: scope(), repository: 30, lease, signal: new AbortController().signal }))
        .limits[0].maximum,
    ).toBe(0)
    await db.query('DELETE FROM box WHERE id=$1', [ids[0]])
    expect(
      (await settings.resolve({ scope: scope(), repository: 30, lease, signal: new AbortController().signal }))
        .limits[0].maximum,
    ).toBe(5)
  })
  it('shares the Box creation exclusion policy for terminal and archiving states', async () => {
    await connect()
    commerce.resolveMaxCreatedBoxes.mockResolvedValue(1)
    const lease = (await native.state.acquire(randomUUID(), 30000))!
    await native.applications().define(lease, scope(), 'test-app')
    for (const state of [
      BoxState.ERROR,
      BoxState.DESTROYING,
      BoxState.DESTROYED,
      BoxState.ARCHIVING,
      BoxState.ARCHIVED,
    ])
      await db.query('INSERT INTO box VALUES($1,$2,$3)', [randomUUID(), org, state])
    expect(
      (await settings.resolve({ scope: scope(), repository: 30, lease, signal: new AbortController().signal }))
        .limits[0].maximum,
    ).toBe(1)
  })
})
