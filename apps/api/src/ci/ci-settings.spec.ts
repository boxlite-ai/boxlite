/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { inspectJournal } from '@boxlite-ai/ci-listener/testing'
import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { ExecutionJournal, ExecutionScope, LeaseLost, StateConflict, StateCorrupt } from '@boxlite-ai/ci-listener'
import { AddCiConnect1793664000000 } from '../migrations/pre-deploy/1793664000000-add-ci-connect-migration'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'
import { BoxState } from '../box/enums/box-state.enum'
import { CiSettingsService } from './ci-settings.service'
import { CiNativeState } from './ci-native-state'
import { AddCiWebConnect1793786400000 } from '../migrations/pre-deploy/1793786400000-add-ci-web-connect-migration'
import { AddCiWebTarget1794000000000 } from '../migrations/pre-deploy/1794000000000-add-ci-web-target-migration'
import { AddCiAccountSelection1793894400000 } from '../migrations/pre-deploy/1793894400000-add-ci-account-selection-migration'

const integration = process.env.DB_HOST ? describe : describe.skip
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
      allowPublic: true,
      allowPrivate: false,
      repository: { id: 30, name: 'repo', private: true, owner: { id: 20, login: 'owner' } },
    },
  })
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
      throw Error('Disposable local database required')
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
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
      await new AddCiWebConnect1793786400000().up(runner)
      await new AddCiAccountSelection1793894400000().up(runner)
      await new AddCiWebTarget1794000000000().up(runner)
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
        (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation,allow_private,state)
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
  it.each(['current', 'owner-revoked', 'generation-changed', 'disconnected', 'foreign-binding'])(
    'scopes repository reads to a current owner and original binding: %s',
    async (scenario) => {
      await connect()
      const read = jest.spyOn(native.registry, 'repositoryPage').mockImplementation(async () => {
        if (scenario === 'owner-revoked')
          await db.query('DELETE FROM organization_user WHERE "userId"=$1', [actor.userId])
        if (scenario === 'generation-changed')
          await db.query('UPDATE ci_installation_binding SET generation=generation+1')
        if (scenario === 'disconnected') await db.query("UPDATE ci_installation_binding SET state='disabled'")
        return {
          repositories: [],
          total: 0,
          page: 1,
          next_page: null,
          repository_selection: 'selected',
          installation_settings_url: 'https://github.com/settings/installations/10',
        }
      })
      try {
        const result = settings.repositories(actor, scenario === 'foreign-binding' ? randomUUID() : binding, 1, 25)
        if (scenario === 'current') {
          await expect(result).resolves.toMatchObject({ total: 0 })
          expect(read).toHaveBeenCalledWith(
            'test-app',
            { installationId: 10, accountId: 20, accountLogin: 'owner', accountType: 'User' },
            1,
            25,
          )
        } else await expect(result).rejects.toThrow()
        if (scenario === 'foreign-binding') expect(read).not.toHaveBeenCalled()
      } finally {
        read.mockRestore()
      }
    },
  )
  it('rejects values above Commerce, negative values and unsafe numbers without saving them', async () => {
    for (const value of [6, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await expect(settings.update(actor, value)).rejects.toBeInstanceOf(BadRequestException)
    expect(await native.state.read([policyKey()])).toEqual([])
  })
  it('reads aggregate limits without requiring an owner or a leader lease', async () => {
    const disabled = new CiSettingsService(new CiNativeState(db, { get: () => undefined } as any), commerce as any)
    expect(await disabled.capacity(org)).toEqual({
      available: false,
      used: 0,
      max_concurrent_jobs: null,
      commerce_limit: null,
      effective_limit: null,
    })
    expect(await settings.capacity(org)).toEqual({
      available: true,
      used: 0,
      max_concurrent_jobs: null,
      commerce_limit: 5,
      effective_limit: 5,
    })
    await settings.update(actor, 0)
    expect(await settings.capacity(org)).toMatchObject({ used: 0, effective_limit: 0 })
    commerce.resolveMaxCreatedBoxes.mockResolvedValue(undefined)
    await settings.update(actor, null)
    expect(await settings.capacity(org)).toMatchObject({ effective_limit: null, commerce_limit: null })
    commerce.resolveMaxCreatedBoxes.mockRejectedValueOnce(Error('Commerce unavailable'))
    await expect(settings.capacity(org)).rejects.toThrow('Commerce unavailable')
  })
  it('counts active slot reservations across creation and cleanup, independent of Box rows and lease ownership', async () => {
    await connect()
    await connect(otherOrg, 11, 21, 'other')
    const journal = new ExecutionJournal(native.state),
      lease = (await native.state.acquire('test-reader', 30000))!
    const original = scope()
    await native.applications().define(lease, original, 'test-app')
    const key = await journal.define(lease, original)
    const policy = await settings.resolve({
      scope: original,
      repository: 30,
      lease,
      signal: new AbortController().signal,
    })
    const reserve = (job: number) => journal.reserve(lease, key, { repository: 30, run: 40, job }, policy)
    await reserve(50)
    const requested = (await reserve(51))!
    await journal.advance(lease, requested.record.key, requested.record.version, {
      box: { phase: 'requested', id: null },
      effect: { kind: 'box-create', id: randomUUID() },
    })
    const closing = (await reserve(52))!,
      box = randomUUID()
    await db.query('INSERT INTO box VALUES($1,$2,$3)', [box, org, BoxState.STOPPED])
    let cleanup = await journal.advance(lease, closing.record.key, closing.record.version, {
      box: { phase: 'requested', id: null },
      effect: { kind: 'box-create', id: randomUUID() },
    })
    cleanup = await journal.advance(lease, cleanup.record.key, cleanup.record.version, {
      box: { phase: 'known', id: box },
    })
    cleanup = await journal.advance(lease, cleanup.record.key, cleanup.record.version, {
      runner: { phase: 'requested', id: null },
      effect: { kind: 'runner-register', id: randomUUID() },
    })
    cleanup = await journal.advance(lease, cleanup.record.key, cleanup.record.version, {
      runner: { phase: 'known', id: 7 },
      closing: true,
      effect: { kind: 'box-remove', id: randomUUID() },
    })
    const [foreignBinding] = await db.query('SELECT id FROM ci_installation_binding WHERE organization_id=$1', [
      otherOrg,
    ])
    const foreign: ExecutionScope = {
      ...original,
      organization: otherOrg,
      binding: foreignBinding.id,
      actor: 'other-owner',
      installation: { id: 11, account: { id: 21, login: 'other', type: 'User' } },
      runners: {
        kind: 'repository',
        allowPublic: true,
        allowPrivate: false,
        repository: { id: 31, name: 'other-repo', private: true, owner: { id: 21, login: 'other' } },
      },
    }
    await native.applications().define(lease, foreign, 'test-app')
    const foreignKey = await journal.define(lease, foreign)
    const foreignPolicy = await settings.resolve({
      scope: foreign,
      repository: 31,
      lease,
      signal: new AbortController().signal,
    })
    await journal.reserve(lease, foreignKey, { repository: 31, run: 40, job: 53 }, foreignPolicy)
    expect(await settings.capacity(org)).toMatchObject({ used: 3 })
    expect(await settings.capacity(otherOrg)).toMatchObject({ used: 1 })
    await journal.advance(lease, cleanup.record.key, cleanup.record.version, {
      box: { phase: 'absent', id: box },
      effect: { kind: 'runner-remove', id: randomUUID() },
    })
    const expected = (await inspectJournal(native.state, lease)).workers.filter(
      (worker) => worker.organization === org,
    ).length
    expect(expected).toBe(2)
    await settings.update(actor, 1)
    await db.query("UPDATE ci_installation_binding SET state='disabled',generation=generation+1")
    await db.query(
      `INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload,updated_at)
        SELECT 'other-namespace',record_key,record_version,schema_version,payload,updated_at FROM ci_listener_state WHERE namespace=$1`,
      [native.namespace],
    )
    await db.query(
      "UPDATE ci_listener_state SET payload=jsonb_set(payload,'{until}','0'),lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND record_key='@owner'",
      [native.namespace],
    )
    await expect(inspectJournal(native.state, lease)).rejects.toBeInstanceOf(LeaseLost)
    const ownerRow = () =>
      db.query("SELECT * FROM ci_listener_state WHERE namespace=$1 AND record_key='@owner'", [native.namespace])
    const before = await ownerRow()
    expect(await settings.capacity(org)).toMatchObject({ used: expected, effective_limit: 1 })
    expect(await ownerRow()).toEqual(before)
  })
  it('reads maintained occupancy and rejects missing or invalid usage counters', async () => {
    await connect()
    const journal = new ExecutionJournal(native.state),
      lease = (await native.state.acquire('test-reader', 30000))!
    await native.applications().define(lease, scope(), 'test-app')
    const key = await journal.define(lease, scope())
    const policy = await settings.resolve({
      scope: scope(),
      repository: 30,
      lease,
      signal: new AbortController().signal,
    })
    const allocation = (await journal.reserve(lease, key, { repository: 30, run: 40, job: 50 }, policy))!
    await db.query(
      "UPDATE ci_listener_state SET payload=jsonb_set(payload,'{box,phase}','\"invalid\"') WHERE namespace=$1 AND record_key=$2",
      [native.namespace, allocation.record.key],
    )
    // Aggregate reads do not enumerate worker history; accessed workers still validate themselves.
    await expect(settings.capacity(org)).resolves.toMatchObject({ used: 1 })
    await expect(journal.allocation(lease, allocation.record.key)).rejects.toBeInstanceOf(StateCorrupt)
    const [usage] = await native.state.scan(lease, { prefix: 'usage/organization/' })
    await db.query('UPDATE ci_listener_state SET payload=$3 WHERE namespace=$1 AND record_key=$2', [
      native.namespace,
      usage.key,
      JSON.stringify({ used: -1 }),
    ])
    await expect(settings.capacity(org)).rejects.toBeInstanceOf(StateCorrupt)
    await db.query('DELETE FROM ci_listener_state WHERE namespace=$1 AND record_key=$2', [native.namespace, usage.key])
    await expect(settings.capacity(org)).rejects.toBeInstanceOf(StateCorrupt)
    await expect(journal.define(lease, scope())).rejects.toBeInstanceOf(StateCorrupt)
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
  it('updates only public policy while preserving the binding, attempts, workers and shared quota', async () => {
    await connect()
    await connect(otherOrg, 11, 21, 'other')
    await settings.update(actor, 2)
    const [before] = await db.query('SELECT * FROM ci_installation_binding WHERE id=$1', [binding])
    const attempt = randomUUID()
    await db.query(
      `INSERT INTO ci_connect_attempt(id,organization_id,user_id,github_account,allow_private,app_client_id,device_ciphertext,expires_at,next_poll_at,interval_seconds)
      VALUES($1,$2,'owner','owner',false,'test-app','encrypted-fixture',clock_timestamp()+interval '5 minutes',clock_timestamp(),5)`,
      [attempt, org],
    )
    const attempts = await db.query('SELECT * FROM ci_connect_attempt')
    const journal = new ExecutionJournal(native.state),
      lease = (await native.state.acquire('update-test', 30000))!
    await native.applications().define(lease, scope(), 'test-app')
    const scopeId = await journal.define(lease, scope())
    const policy = await settings.resolve({
      scope: scope(),
      repository: 30,
      lease,
      signal: new AbortController().signal,
    })
    const allocation = (await journal.reserve(lease, scopeId, { repository: 30, run: 40, job: 50 }, policy))!
    const keys = [policyKey(), scopeId, allocation.record.key]
    const records = await native.state.read(keys)
    await settings.updateConnection(actor, binding, false)
    expect((await db.query('SELECT * FROM ci_installation_binding WHERE id=$1', [binding]))[0]).toEqual(before)
    await settings.updateConnection(actor, binding, true)
    const wake = await native.state.read(['wake/10/0'])
    expect(wake[0].payload).toEqual({ installationId: 10, accountId: 20, repositoryId: 0 })
    await settings.updateConnection(actor, binding, true)
    expect(await native.state.read(['wake/10/0'])).toEqual(wake)
    expect((await db.query('SELECT * FROM ci_installation_binding WHERE id=$1', [binding]))[0]).toEqual({
      ...before,
      allow_private: true,
      generation: '2',
      state: 'provisioning',
    })
    expect(await db.query('SELECT * FROM ci_connect_attempt')).toEqual(attempts)
    expect(await native.state.read(keys)).toEqual(records)
    expect((await settings.get({ organizationId: otherOrg, userId: 'other-owner' })).connections[0]).toMatchObject({
      allow_private_repositories: false,
      listener_status: 'ready',
    })
    await expect(native.transaction((tx) => native.admit(tx, scope(), 'test-app'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await native.transaction((tx) =>
      native.admit(tx, { ...scope(), generation: 2, runners: { ...scope().runners, allowPrivate: true } }, 'test-app'),
    )
  })
  it('rejects foreign, unknown, non-owner and disabled connection updates', async () => {
    await connect()
    await expect(
      settings.updateConnection({ organizationId: otherOrg, userId: 'other-owner' }, binding, true),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(settings.updateConnection(actor, randomUUID(), true)).rejects.toBeInstanceOf(NotFoundException)
    await db.query('UPDATE organization_user SET role=\'member\' WHERE "organizationId"=$1', [org])
    await expect(settings.updateConnection(actor, binding, true)).rejects.toBeInstanceOf(ForbiddenException)
    await db.query('UPDATE organization_user SET role=\'owner\' WHERE "organizationId"=$1', [org])
    await settings.deleteConnection(actor, binding)
    await expect(settings.updateConnection(actor, binding, true)).rejects.toBeInstanceOf(ConflictException)
    expect(
      (await db.query('SELECT state,allow_private,generation FROM ci_installation_binding WHERE id=$1', [binding]))[0],
    ).toEqual({ state: 'disabled', allow_private: false, generation: '2' })
  })
  it('rechecks delegated scopes and rolls back a policy update when its key expires before commit', async () => {
    await connect()
    const hash = 'e'.repeat(64)
    await db.query(`INSERT INTO api_key VALUES($1,$2,'owner',ARRAY['write:boxes'],NULL)`, [hash, org])
    const delegated = { ...actor, apiKey: { keyHash: hash } }
    await expect(settings.updateConnection(delegated, binding, true)).rejects.toBeInstanceOf(ForbiddenException)
    await db.query(
      `UPDATE api_key SET permissions=ARRAY['write:boxes','delete:boxes'],"expiresAt"=clock_timestamp()-interval '1 second' WHERE "keyHash"=$1`,
      [hash],
    )
    await expect(settings.updateConnection(delegated, binding, false)).rejects.toBeInstanceOf(ForbiddenException)
    await db.query(`CREATE FUNCTION delay_ci_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$;
      CREATE TRIGGER delay_ci_binding BEFORE UPDATE ON ci_installation_binding FOR EACH ROW EXECUTE FUNCTION delay_ci_binding()`)
    try {
      await db.query(
        'UPDATE api_key SET "expiresAt"=clock_timestamp()+interval \'150 milliseconds\' WHERE "keyHash"=$1',
        [hash],
      )
      await expect(settings.updateConnection(delegated, binding, true)).rejects.toBeInstanceOf(ForbiddenException)
    } finally {
      await db.query('DROP TRIGGER delay_ci_binding ON ci_installation_binding; DROP FUNCTION delay_ci_binding()')
    }
    expect(
      (await db.query('SELECT state,allow_private,generation FROM ci_installation_binding WHERE id=$1', [binding]))[0],
    ).toEqual({ state: 'ready', allow_private: false, generation: '1' })
  })
  it('deletes only the owned connection, keeps quota and advances generation once', async () => {
    await connect()
    await connect(otherOrg, 11, 21, 'other')
    await settings.update(actor, 2)
    await settings.deleteConnection(actor, binding)
    await settings.deleteConnection(actor, binding)
    expect(await settings.get(actor)).toMatchObject({ max_concurrent_jobs: 2, connections: [] })
    expect(await db.query('SELECT state,generation FROM ci_installation_binding WHERE id=$1', [binding])).toEqual([
      { state: 'disabled', generation: '2' },
    ])
    expect((await settings.get({ organizationId: otherOrg, userId: 'other-owner' })).connections).toHaveLength(1)
    await expect(native.transaction((tx) => native.admit(tx, scope(), 'test-app'))).rejects.toThrow('no longer active')
  })
  it('refuses member, foreign connection and expired delegated key deletions without mutation', async () => {
    await connect()
    await expect(
      settings.deleteConnection({ organizationId: otherOrg, userId: 'other-owner' }, binding),
    ).rejects.toBeInstanceOf(NotFoundException)
    await db.query('UPDATE organization_user SET role=\'member\' WHERE "organizationId"=$1', [org])
    await expect(settings.deleteConnection(actor, binding)).rejects.toBeInstanceOf(ForbiddenException)
    await db.query('UPDATE organization_user SET role=\'owner\' WHERE "organizationId"=$1', [org])
    const keyHash = 'a'.repeat(64)
    await db.query(
      `INSERT INTO api_key VALUES($1,$2,'owner',ARRAY['write:boxes','delete:boxes'],now()-interval '1 second')`,
      [keyHash, org],
    )
    await expect(settings.deleteConnection({ ...actor, apiKey: { keyHash } }, binding)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(await db.query('SELECT state,generation FROM ci_installation_binding WHERE id=$1', [binding])).toEqual([
      { state: 'ready', generation: '1' },
    ])
  })
  it.each(['delete', 'update'])(
    'waits for prior admitted work during %s, then denies its stale generation',
    async (operation) => {
      await connect()
      const prior = db.createQueryRunner()
      await prior.connect()
      await prior.startTransaction()
      try {
        await native.admit(prior.manager, scope(), 'test-app')
        const mutation =
          operation === 'delete'
            ? settings.deleteConnection(actor, binding)
            : settings.updateConnection(actor, binding, true)
        const deadline = Date.now() + 1000
        let blocked = false
        while (Date.now() < deadline) {
          const [row] = await db.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1) AS blocked",
            [
              operation === 'delete'
                ? '%UPDATE ci_installation_binding SET state=%'
                : '%ci_installation_binding%FOR UPDATE%',
            ],
          )
          if (row.blocked) {
            blocked = true
            break
          }
        }
        expect(blocked).toBe(true)
        await prior.commitTransaction()
        await mutation
        await expect(native.transaction((tx) => native.admit(tx, scope(), 'test-app'))).rejects.toThrow(
          'no longer active',
        )
      } finally {
        if (prior.isTransactionActive) await prior.rollbackTransaction()
        await prior.release()
      }
    },
  )
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
    expect((await inspectJournal(native.state, lease)).allocations.size).toBe(0)
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
    expect(await native.state.scan(lease, { prefix: 'scope/' })).toEqual([])
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
    expect((await inspectJournal(native.state, lease)).allocations.size).toBe(0)
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
          allowPublic: true,
          allowPrivate: false,
          repository: { id: installation + 30, name: 'repo', owner: { id: account, login }, private: true },
        },
      }
    }
    expect(await reserve(await makeScope(11, org, 'owner', 21, 'other'))).toBeUndefined()
    expect(await reserve(await makeScope(12, otherOrg, 'other-owner', 22, 'third'))).toBeDefined()
    expect((await inspectJournal(native.state, lease)).workers).toHaveLength(2)
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
        allowPublic: true,
        allowPrivate: false,
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
    expect((await inspectJournal(native.state, lease)).workers).toHaveLength(1)
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
