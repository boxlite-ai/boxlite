import { AddCiPrivatePolicy1794312000000 } from '../migrations/pre-deploy/1794312000000-add-ci-private-policy-migration'
import { BadGatewayException } from '@nestjs/common'
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { testCapacity } from '@boxlite-ai/ci-listener/testing'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddCiConnect1793664000000 } from '../migrations/pre-deploy/1793664000000-add-ci-connect-migration'
import { CiConnectService } from './ci-connect.service'
import { CiGitHubService, CiInstallationRequired } from './ci-github.service'
import { CiSecretsService } from './ci-secrets.service'
import { CiNativeState } from './ci-native-state'
import { CiSettingsService } from './ci-settings.service'
import { AddCiWebConnect1793786400000 } from '../migrations/pre-deploy/1793786400000-add-ci-web-connect-migration'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'
import { AddCiWebTarget1794000000000 } from '../migrations/pre-deploy/1794000000000-add-ci-web-target-migration'
import { AddCiAccountSelection1793894400000 } from '../migrations/pre-deploy/1793894400000-add-ci-account-selection-migration'
import { Listener, ListenerInbox } from '@boxlite-ai/ci-listener'

const databaseUrl = process.env.CI_CONNECT_TEST_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('CI connect persistence (real Postgres)', () => {
  const schema = `ci_${randomUUID().replaceAll('-', '')}`
  const org = randomUUID(),
    otherOrg = randomUUID()
  const actor = { organizationId: org, userId: 'owner' }
  const input = { github_account: 'alice', follow_installation: true as const, allow_private_repositories: false }
  const encryptionKey = randomBytes(32).toString('base64')
  const secrets = new CiSecretsService({ get: () => encryptionKey } as any)
  let db: DataSource, service: CiConnectService, native: CiNativeState, settings: CiSettingsService
  const github = {
    ids: ['app-client', 'org-client'],
    identity: jest.fn(() => github),
    authorizationApp: jest.fn(() => github),
    clientId: 'app-client',
    accountType: 'User',
    forAccount: jest.fn(async () => github),
    forType: jest.fn(() => github),
    byClientId: jest.fn(() => github),
    configured: () => [github],
    availableInstallations: jest.fn(),
    availableAccounts: jest.fn(),
    repositoryPage: jest.fn(),
    ownedAccounts: jest.fn(),
    installationFor: jest.fn(),
    isIdentityClient: jest.fn(() => false),
    settings: () => ({ clientId: 'app-client', installationUrl: 'https://github.com/apps/example/installations/new' }),
    startDevice: jest.fn(),
    webSettings: () => ({
      clientId: 'app-client',
      installationUrl: 'https://github.com/apps/example/installations/new',
      redirectUri: 'https://console.test/settings/ci/callback',
    }),
    authorizeWeb: (state: string, challenge: string) =>
      'https://github.com/login/oauth/authorize?' + new URLSearchParams({ state, code_challenge: challenge }),
    exchangeWeb: jest.fn(),
    pollDevice: jest.fn(),
    verifyUserInstallation: jest.fn(),
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Disposable local database required')
    const setup = await new DataSource({ type: 'postgres', url: databaseUrl, entities: [] }).initialize()
    await setup.query(`CREATE SCHEMA "${schema}"`)
    await setup.destroy()
    db = await new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities: [],
      extra: { options: `-c search_path=${schema}` },
    }).initialize()
    await db.query('CREATE TABLE organization (id uuid PRIMARY KEY)')
    await db.query(`CREATE TABLE "user" (id text PRIMARY KEY,role text NOT NULL);
      CREATE TABLE organization_user("organizationId" uuid NOT NULL,"userId" text NOT NULL,role text NOT NULL,
        PRIMARY KEY("organizationId","userId"));
      CREATE TABLE api_key("keyHash" text PRIMARY KEY,"organizationId" uuid NOT NULL,"userId" text NOT NULL,
        permissions text[] NOT NULL,"expiresAt" timestamptz NULL)`)

    await db.query('INSERT INTO organization VALUES ($1),($2)', [org, otherOrg])
    const runner = db.createQueryRunner()
    try {
      await new AddCiConnect1793664000000().up(runner)
      await new AddCiWebConnect1793786400000().up(runner)
      await new AddCiAccountSelection1793894400000().up(runner)
      await new AddCiWebTarget1794000000000().up(runner)
      await new AddCiListenerState1793700000000().up(runner)
      await new AddCiPrivatePolicy1794312000000().up(runner)
    } finally {
      await runner.release()
    }
  })
  afterAll(async () => {
    if (!db?.isInitialized) return
    try {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await db.destroy()
    }
  })
  beforeEach(async () => {
    await db.query(
      'TRUNCATE ci_connect_attempt, ci_installation_binding, ci_listener_state, "user", organization_user, api_key',
    )
    native = new CiNativeState(db, {
      get: (key: string) => ({ 'ci.githubClientId': 'app-client', 'ci.githubOrgClientId': 'org-client' })[key],
    } as any)
    await native.initialize()
    settings = new CiSettingsService(native, { resolveMaxCreatedBoxes: async () => 5 } as any)
    await settings.initialize()
    await db.query(`INSERT INTO "user" VALUES ('owner','user'),('other-owner','user'),('temporary-owner','user')`)
    await db.query(`INSERT INTO organization_user VALUES ($1,'owner','owner'),($2,'other-owner','owner')`, [
      org,
      otherOrg,
    ])
    github.startDevice.mockReset().mockResolvedValue({
      device_code: 'secret-device',
      user_code: 'TEST-CODE',
      verification_uri: 'https://github.com/login/device',
      expires_in: 600,
      interval: 5,
    })
    github.pollDevice.mockReset().mockResolvedValue({ access_token: 'github-user-token' })
    github.exchangeWeb.mockReset().mockResolvedValue('github-web-user-token')
    github.isIdentityClient.mockReset().mockReturnValue(false)
    github.availableAccounts.mockReset()
    github.identity.mockReset().mockReturnValue(github)
    github.authorizationApp.mockReset().mockReturnValue(github)
    github.forType.mockReset().mockReturnValue(github)
    github.byClientId.mockReset().mockReturnValue(github)
    github.ownedAccounts.mockReset()
    github.installationFor.mockReset()
    github.availableInstallations
      .mockReset()
      .mockResolvedValue([{ installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' }])
    github.verifyUserInstallation
      .mockReset()
      .mockResolvedValue({ installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' })
    service = new CiConnectService(db, github as unknown as CiGitHubService, secrets, native, settings)
  })
  it.each([true, false])('reports Login OAuth availability independently from CI Apps: %s', (available) => {
    const settings = jest.spyOn(github, 'webSettings')
    if (!available)
      settings.mockImplementation(() => {
        throw Error('missing client secret')
      })
    try {
      expect(service.configuration()).toMatchObject({
        web_connect_available: available,
        apps: [{ account_type: 'User', web_connect_available: available }],
      })
    } finally {
      settings.mockRestore()
    }
  })
  it.each(['expired', 'lease-expired'])(
    'erases an unusable browser grant on authenticated resume: %s',
    async (state) => {
      const { attempt } = await accountSession()
      if (state === 'expired')
        await db.query("UPDATE ci_connect_attempt SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
          attempt.id,
        ])
      else
        await db.query(
          "UPDATE ci_connect_attempt SET state='polling',lease_id=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
          [attempt.id, randomUUID()],
        )
      expect((await service.getWeb(actor, attempt.id)).status).toBe(state === 'expired' ? 'expired' : 'failed')
      const [row] = await db.query(
        'SELECT oauth_token_ciphertext,web_target_ciphertext,lease_id FROM ci_connect_attempt WHERE id=$1',
        [attempt.id],
      )
      expect(row).toEqual({ oauth_token_ciphertext: null, web_target_ciphertext: null, lease_id: null })
    },
  )
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid account selection before claiming a grant: %s',
    async (account_id) => {
      const { attempt } = await accountSession()
      await expect(
        service.selectAccount(actor, attempt.id, { account_id, allow_private_repositories: false }),
      ).rejects.toThrow('Invalid GitHub account selection')
      expect((await service.getWeb(actor, attempt.id)).status).toBe('selection_required')
    },
  )
  it('rejects account selection before login and ownership lost after inventory', async () => {
    const attempt = await web()
    github.isIdentityClient.mockReturnValue(true)
    await expect(
      service.selectAccount(actor, attempt.id, { account_id: 456, allow_private_repositories: false }),
    ).rejects.toThrow('login required')
    const { attempt: loggedIn } = await accountSession()
    await expect(
      service.selectAccount(actor, loggedIn.id, { account_id: 999, allow_private_repositories: false }),
    ).rejects.toThrow('Current GitHub account owner')
    expect((await service.getWeb(actor, loggedIn.id)).status).toBe('failed')
  })
  it.each(['cancelled', 'expired'])('does not revive a %s grant after a delayed provider error', async (scenario) => {
    const { attempt } = await accountSession()
    github.ownedAccounts.mockImplementationOnce(async () => {
      if (scenario === 'cancelled') await service.cancel(actor, attempt.id)
      else
        await db.query("UPDATE ci_connect_attempt SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
          attempt.id,
        ])
      throw new BadGatewayException('GitHub unavailable')
    })
    await expect(
      service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false }),
    ).rejects.toThrow('GitHub unavailable')
    expect((await service.getWeb(actor, attempt.id)).status).toBe(scenario)
    const [row] = await db.query('SELECT oauth_token_ciphertext FROM ci_connect_attempt WHERE id=$1', [attempt.id])
    expect(row.oauth_token_ciphertext).toBeNull()
  })
  it('rejects unknown and device attempts at the browser resume boundary', async () => {
    await expect(service.getWeb(actor, randomUUID())).rejects.toThrow('not found')
    const attempt = await service.start(actor, input)
    await expect(service.getWeb(actor, attempt.id)).rejects.toThrow('Browser authorization required')
  })
  it.each(['cancelled', 'identity-changed', 'installation-missing'])(
    'keeps account-selection authority pinned: %s',
    async (scenario) => {
      const { attempt, installed } = await accountSession()
      if (scenario === 'cancelled') {
        await service.cancel(actor, attempt.id)
        expect(
          (await service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false }))
            .status,
        ).toBe('cancelled')
      } else if (scenario === 'identity-changed') {
        github.isIdentityClient.mockReturnValue(false)
        await expect(
          service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false }),
        ).rejects.toThrow('identity OAuth App changed')
      } else {
        installed.delete(789)
        const selected = await service.selectAccount(actor, attempt.id, {
          account_id: 789,
          allow_private_repositories: false,
        })
        const state = new URL(selected.installation_url).searchParams.get('state')!
        await expect(service.completeInstallation(actor, attempt.id, 321, state)).rejects.toThrow(
          'installation is unavailable',
        )
      }
      expect(await db.query('SELECT id FROM ci_installation_binding')).toEqual([])
    },
  )
  it('rejects unverified API key identity before querying key authority', async () => {
    const started = await service.startWeb(actor, input)
    const state = new URL(started.authorization_url).searchParams.get('state')!
    await expect(
      service.completeWeb({ ...actor, apiKey: { keyHash: '' } }, started.id, { code: 'code', state }),
    ).rejects.toThrow('Verified API key identity')
    expect(github.exchangeWeb).not.toHaveBeenCalled()
  })
  it('web migration expands existing device rows and can be rolled back independently', async () => {
    const device = await service.start(actor, input)
    const runner = db.createQueryRunner()
    try {
      await new AddCiAccountSelection1793894400000().down(runner)
      await new AddCiWebConnect1793786400000().down(runner)
      await new AddCiWebConnect1793786400000().up(runner)
      await new AddCiAccountSelection1793894400000().up(runner)
      const [row] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [device.id])
      expect(row).toMatchObject({ flow: 'device', oauth_state_hash: null, oauth_verifier_ciphertext: null })
      expect(row.device_ciphertext).toBeTruthy()
    } finally {
      await runner.release()
    }
  })
  async function begin(who = actor, body = input) {
    const attempt = await service.start(who, body)
    await db.query("UPDATE ci_connect_attempt SET next_poll_at=now()-interval '1 second' WHERE id=$1", [attempt.id])
    return attempt
  }
  async function web(who = actor) {
    const attempt = await service.startWeb(who, {
      account_type: 'User',
      follow_installation: true,
      allow_private_repositories: false,
    })
    const url = new URL(attempt.authorization_url)
    return { ...attempt, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! }
  }
  it.each(['invalid-id', 'pending', 'expired', 'lease-expired'])(
    'denies legacy selection without a live grant: %s',
    async (scenario) => {
      const attempt = await web()
      if (scenario === 'expired')
        await db.query("UPDATE ci_connect_attempt SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [
          attempt.id,
        ])
      if (scenario === 'lease-expired')
        await db.query(
          "UPDATE ci_connect_attempt SET state='polling',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
          [attempt.id],
        )
      const completion = service.selectWeb(actor, attempt.id, scenario === 'invalid-id' ? 0 : 123)
      if (scenario === 'invalid-id' || scenario === 'pending')
        await expect(completion).rejects.toThrow(
          scenario === 'invalid-id' ? 'Invalid GitHub installation' : 'GitHub authorization is required',
        )
      else await expect(completion).resolves.toMatchObject({ status: scenario === 'expired' ? 'expired' : 'failed' })
      expect(github.verifyUserInstallation).not.toHaveBeenCalled()
    },
  )
  it('web connect exchanges once, persists an encrypted selection token and binds only after selecting', async () => {
    const attempt = await web()
    const [stored] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
    expect(stored.flow).toBe('web')
    expect(stored.device_ciphertext).toBeNull()
    expect(stored.oauth_state_hash).toBe(createHash('sha256').update(attempt.state).digest('hex'))
    expect(JSON.stringify(stored)).not.toContain(attempt.state)
    const verifier = secrets.open(
      stored.oauth_verifier_ciphertext,
      JSON.stringify([attempt.id, actor.userId, org]) + ':web-pkce',
    )
    expect(attempt.challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(attempt.state).not.toContain(verifier)
    github.exchangeWeb.mockImplementation(async (code, received) => {
      expect(code).toBe('web-code')
      expect(received).toBe(verifier)
      const [claimed] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
      expect(claimed).toMatchObject({ state: 'polling', oauth_verifier_ciphertext: null })
      return 'github-web-user-token'
    })
    const results = await Promise.all([
      service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state }),
      service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state }),
    ])
    expect(results.some((value) => value.status === 'selection_required')).toBe(true)
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
    expect(github.verifyUserInstallation).not.toHaveBeenCalled()
    const [selection] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
    expect(selection.oauth_token_ciphertext).toBeTruthy()
    expect(JSON.stringify(selection)).not.toContain('github-web-user-token')
    const selected = await Promise.all([
      service.selectWeb(actor, attempt.id, 123),
      service.selectWeb(actor, attempt.id, 123),
    ])
    expect(selected.some((value) => value.status === 'connected')).toBe(true)
    expect(github.verifyUserInstallation).toHaveBeenCalledTimes(1)
    expect(github.verifyUserInstallation).toHaveBeenCalledWith('github-web-user-token', 123)
    expect((await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })).status).toBe(
      'connected',
    )
    expect(github.exchangeWeb).toHaveBeenCalledTimes(1)
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(1)
    expect((await native.state.read(['quota/' + org]))[0].payload).toMatchObject({ organization: org, maximum: null })
    expect(await native.state.read(['wake/123/0'])).toHaveLength(1)
    expect(JSON.stringify(await db.query('SELECT * FROM ci_connect_attempt'))).not.toContain(verifier)
  })
  it('web connect rejects forged state, other actors and mixed grants before exchanging a code', async () => {
    const attempt = await web(),
      body = { code: 'web-code', state: attempt.state }
    await expect(
      service.completeWeb(actor, attempt.id, {
        ...body,
        state: attempt.state.slice(0, -1) + (attempt.state.endsWith('A') ? 'B' : 'A'),
      }),
    ).rejects.toThrow('state mismatch')
    await expect(service.completeWeb({ ...actor, organizationId: otherOrg }, attempt.id, body)).rejects.toThrow(
      'not found',
    )
    await expect(service.completeWeb({ ...actor, userId: 'other-owner' }, attempt.id, body)).rejects.toThrow(
      'not found',
    )
    await expect(service.poll(actor, attempt.id)).rejects.toThrow('completion endpoint')
    const device = await begin()
    await expect(service.completeWeb(actor, device.id, body)).rejects.toThrow('state mismatch')
    expect(github.exchangeWeb).not.toHaveBeenCalled()
    expect(github.pollDevice).not.toHaveBeenCalled()
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
  })
  it('web connect expires or cancels without exchanging and erases temporary ciphertext', async () => {
    const expired = await web()
    await db.query("UPDATE ci_connect_attempt SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id])
    expect((await service.completeWeb(actor, expired.id, { code: 'web-code', state: expired.state })).status).toBe(
      'expired',
    )
    const cancelled = await web()
    await service.cancel(actor, cancelled.id)
    expect((await service.completeWeb(actor, cancelled.id, { code: 'web-code', state: cancelled.state })).status).toBe(
      'cancelled',
    )
    expect(github.exchangeWeb).not.toHaveBeenCalled()
    expect(
      (await db.query('SELECT oauth_verifier_ciphertext FROM ci_connect_attempt')).every(
        (row) => row.oauth_verifier_ciphertext === null,
      ),
    ).toBe(true)
  })
  it('web connect cannot exchange after owner revocation', async () => {
    const attempt = await web()
    await db.query('DELETE FROM organization_user WHERE "organizationId"=$1', [org])
    await expect(service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })).rejects.toThrow(
      'owner authority',
    )
    expect(github.exchangeWeb).not.toHaveBeenCalled()
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
  })
  it('web connect treats an uncertain exchange as terminal and does not retry its code', async () => {
    const attempt = await web(),
      body = { code: 'private-web-code', state: attempt.state }
    github.exchangeWeb.mockRejectedValueOnce(Error('private-upstream-token'))
    const first = await service.completeWeb(actor, attempt.id, body)
    expect(first.status).toBe('failed')
    expect((await service.completeWeb(actor, attempt.id, body)).status).toBe('failed')
    expect(github.exchangeWeb).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(first)).not.toContain(body.code)
    expect(JSON.stringify(first)).not.toContain('private-upstream-token')
    expect(
      (await db.query('SELECT oauth_verifier_ciphertext FROM ci_connect_attempt'))[0].oauth_verifier_ciphertext,
    ).toBeNull()
  })
  it('web connect reports the install link without trusting a caller-supplied installation', async () => {
    const attempt = await web()
    github.availableInstallations.mockResolvedValueOnce([])
    const result = await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })
    expect(result).toMatchObject({
      status: 'selection_required',
      accounts: [],
    })
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
  })
  it('web connect rechecks authority after GitHub verification and rolls back all binding writes', async () => {
    const attempt = await web()
    github.verifyUserInstallation.mockImplementationOnce(async () => {
      await db.query('DELETE FROM organization_user WHERE "organizationId"=$1', [org])
      return { installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' }
    })
    await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })
    expect((await service.selectWeb(actor, attempt.id, 123)).status).toBe('failed')
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
    expect(await native.state.read(['quota/' + org, 'wake/123/0'])).toEqual([])
  })
  it('web connect cannot finish a cancelled in-flight exchange', async () => {
    const attempt = await web()
    github.exchangeWeb.mockImplementationOnce(async () => {
      await service.cancel(actor, attempt.id)
      return 'github-web-user-token'
    })
    expect((await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })).status).toBe(
      'cancelled',
    )
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
  })
  it('web connect cannot reclaim an uncertain exchange after its lease expires', async () => {
    const attempt = await web()
    await db.query(
      "UPDATE ci_connect_attempt SET state='polling',lease_id=$2,lease_until=now()-interval '1 second',oauth_verifier_ciphertext=NULL WHERE id=$1",
      [attempt.id, randomUUID()],
    )
    expect((await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })).status).toBe(
      'failed',
    )
    expect(github.exchangeWeb).not.toHaveBeenCalled()
  })
  it.each(['expired', 'cancelled', 'forged-state', 'other-actor', 'wrong-id', 'revoked'])(
    'denies account selection at the %s boundary',
    async (kind) => {
      const attempt = await web()
      await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })
      if (kind === 'expired')
        await db.query("UPDATE ci_connect_attempt SET expires_at=now()-interval '1 second' WHERE id=$1", [attempt.id])
      if (kind === 'cancelled') await service.cancel(actor, attempt.id)
      if (kind === 'revoked') await db.query('DELETE FROM organization_user')
      if (kind === 'wrong-id')
        github.verifyUserInstallation.mockResolvedValueOnce({
          installationId: 999,
          accountId: 456,
          accountLogin: 'alice',
          accountType: 'User',
        })
      if (kind === 'forged-state')
        await expect(service.selectWeb(actor, attempt.id, 123, attempt.id + '.' + 'B'.repeat(43))).rejects.toThrow(
          'state mismatch',
        )
      else if (kind === 'other-actor')
        await expect(service.selectWeb({ ...actor, userId: 'other-owner' }, attempt.id, 123)).rejects.toThrow(
          'not found',
        )
      else if (kind === 'revoked')
        await expect(service.selectWeb(actor, attempt.id, 123)).rejects.toThrow('owner authority')
      else expect((await service.selectWeb(actor, attempt.id, 123)).status).toBe(kind === 'wrong-id' ? 'failed' : kind)
      expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
      if (['expired', 'cancelled', 'wrong-id'].includes(kind)) {
        const [row] = await db.query('SELECT oauth_token_ciphertext FROM ci_connect_attempt WHERE id=$1', [attempt.id])
        expect(row.oauth_token_ciphertext).toBeNull()
      }
      if (kind !== 'wrong-id') expect(github.verifyUserInstallation).not.toHaveBeenCalled()
    },
  )
  it('auto-binds an installed account only with the original state and fresh installation verification', async () => {
    const attempt = await web()
    github.availableInstallations.mockResolvedValue([])
    const result = await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })
    expect(new URL(result.installation_url!).searchParams.get('state')).toBe(attempt.state)
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
    expect((await service.selectWeb(actor, attempt.id, 123, attempt.state)).status).toBe('connected')
    expect((await service.selectWeb(actor, attempt.id, 123, attempt.state)).status).toBe('connected')
    expect(github.verifyUserInstallation).toHaveBeenCalledWith('github-web-user-token', 123)
    expect(github.verifyUserInstallation).toHaveBeenCalledTimes(1)
    const [stored] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
    expect(stored.oauth_token_ciphertext).toBeNull()
  })
  // Version/race cases begin with an earlier installation notification. The
  // connect under test must refresh it independently of that prior producer.
  const priorInventoryEvent = () =>
    new ListenerInbox(native.state).receive({
      delivery: randomUUID(),
      event: 'installation',
      digest: '1'.repeat(64),
      hint: { installationId: 123, accountId: 456, repositoryId: 0, job: null },
    })
  it('persists encrypted authorization, resumes on another instance, and reports provisioning honestly', async () => {
    const attempt = await begin()
    expect(JSON.stringify(attempt)).not.toContain('secret-device')
    const [row] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
    expect(row.device_ciphertext).not.toContain('secret-device')
    expect(() => secrets.open(row.device_ciphertext, JSON.stringify([row.id, 'attacker', org]))).toThrow()
    const restarted = new CiConnectService(db, github as any, secrets, native, settings)
    expect(await restarted.poll(actor, attempt.id)).toMatchObject({
      status: 'connected',
      listener_status: 'provisioning',
    })
    expect(await restarted.poll(actor, attempt.id)).toMatchObject({ status: 'connected' })
    expect(github.pollDevice).toHaveBeenCalledTimes(1)
    expect(
      (await db.query('SELECT device_ciphertext FROM ci_connect_attempt WHERE id=$1', [attempt.id]))[0]
        .device_ciphertext,
    ).toBeNull()
  })
  it('commits a durable inventory wake before reporting connected', async () => {
    const attempt = await begin()
    expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'connected' })
    const [wake] = await native.state.read(['wake/123/0'])
    expect(wake?.payload).toEqual({ installationId: 123, accountId: 456, repositoryId: 0 })
  })
  it('rolls back the binding when its inventory wake cannot persist', async () => {
    const attempt = await begin()
    await db.query(`CREATE FUNCTION reject_connect_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.record_key='wake/123/0' THEN RAISE EXCEPTION 'test wake failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_connect_wake BEFORE INSERT OR UPDATE ON ci_listener_state FOR EACH ROW EXECUTE FUNCTION reject_connect_wake()`)
    try {
      expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'failed' })
    } finally {
      await db.query('DROP TRIGGER reject_connect_wake ON ci_listener_state; DROP FUNCTION reject_connect_wake()')
    }
    expect(await db.query('SELECT id FROM ci_installation_binding')).toHaveLength(0)
    expect(await native.state.read(['wake/123/0'])).toHaveLength(0)
  })
  it('keeps the final authorization decision after the inventory wake work', async () => {
    const attempt = await begin()
    await db.query(`CREATE FUNCTION expire_connect_at_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.record_key='wake/123/0' THEN UPDATE ci_connect_attempt SET expires_at=clock_timestamp()-interval '1 second' WHERE state='polling'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER expire_connect_at_wake BEFORE INSERT OR UPDATE ON ci_listener_state FOR EACH ROW EXECUTE FUNCTION expire_connect_at_wake()`)
    try {
      expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'failed' })
    } finally {
      await db.query('DROP TRIGGER expire_connect_at_wake ON ci_listener_state; DROP FUNCTION expire_connect_at_wake()')
    }
    expect(await db.query('SELECT id FROM ci_installation_binding')).toHaveLength(0)
    expect(await native.state.read(['wake/123/0'])).toHaveLength(0)
  })
  it('refreshes a running controller after connect without waiting for its directory interval', async () => {
    let first!: () => void, second!: () => void, timer: ReturnType<typeof setTimeout>
    const initial = new Promise<void>((resolve) => {
      first = resolve
    })
    const refreshed = new Promise<void>((resolve, reject) => {
      second = resolve
      timer = setTimeout(() => reject(Error('Connect did not wake directory discovery')), 3000)
    })
    const snapshots: number[] = []
    const host = {
      discover: async (_lease, _signal, request) => {
        snapshots.push((await db.query('SELECT id FROM ci_installation_binding')).length)
        if (snapshots.length === 1) first()
        else second()
        return { scopes: [], completed: request.wakes, pending: false, ready: true }
      },
      backend: async () => {
        throw Error('No execution scope in this directory handoff test')
      },
      scan: async () => {
        throw Error('No scan catalog in this directory handoff test')
      },
      accept: async () => {
        throw Error('No webhook in this connect handoff test')
      },
      report: jest.fn(),
    }
    const controller = new Listener({
      state: native.state,
      host,
      worker: { image: 'runner:test', cpus: 1, memoryMiB: 512, labels: ['boxlite-ci-runner'] },
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 1 }) },
      timing: { tickMs: 10, leaseMs: 5000, discoveryMs: 60000 },
    })
    const stop = new AbortController(),
      task = controller.run(stop.signal)
    try {
      await initial
      const attempt = await begin()
      expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'connected' })
      await refreshed
      expect(snapshots.slice(0, 2)).toEqual([0, 1])
      expect(host.report).not.toHaveBeenCalled()
    } finally {
      clearTimeout(timer!)
      stop.abort()
      await task
    }
  }, 10000)
  it('refreshes the inventory wake for a new connect but not for a duplicate completed poll', async () => {
    await priorInventoryEvent()
    const first = await begin()
    expect(await service.poll(actor, first.id)).toMatchObject({ status: 'connected' })
    const [old] = await native.state.read(['wake/123/0'])
    const second = await begin()
    expect(await service.poll(actor, second.id)).toMatchObject({ status: 'connected' })
    const [current] = await native.state.read(['wake/123/0'])
    expect(current.version).not.toBe(old.version)
    expect(await service.poll(actor, second.id)).toMatchObject({ status: 'connected' })
    expect((await native.state.read(['wake/123/0']))[0].version).toBe(current.version)
  })
  it('reconnect reactivates a disabled binding with a fresh generation', async () => {
    const first = await begin()
    expect(await service.poll(actor, first.id)).toMatchObject({ status: 'connected' })
    await db.query("UPDATE ci_installation_binding SET state='disabled',generation=2")
    const second = await begin()
    expect(await service.poll(actor, second.id)).toMatchObject({ status: 'connected' })
    const [binding] = await db.query('SELECT state,generation FROM ci_installation_binding')
    expect(binding).toEqual({ state: 'provisioning', generation: '3' })
  })
  it.each(['ready', 'disabled'])('refreshes a verified renamed account on %s reconnect', async (state) => {
    const first = await begin()
    await service.poll(actor, first.id)
    const [original] = await db.query('SELECT id FROM ci_installation_binding')
    await db.query('UPDATE ci_installation_binding SET account_login=$1,state=$2,generation=2', ['old-alice', state])
    const second = await begin()
    expect(await service.poll(actor, second.id)).toMatchObject({ status: 'connected' })
    const rows = await db.query('SELECT id,account_login,state,generation,allow_private FROM ci_installation_binding')
    expect(rows).toEqual([
      { id: original.id, account_login: 'alice', state: 'provisioning', generation: '3', allow_private: false },
    ])
  })
  async function fillBindings(count: number) {
    await settings.ensure(db.manager, org)
    await db.query(
      `INSERT INTO ci_installation_binding
      (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation,allow_private,state)
      SELECT gen_random_uuid(),'github.com','app-client',1000+n,2000+n,'account-'||n,'User',$1,'owner',true,false,'ready'
      FROM generate_series(1,$2::int) n`,
      [org, count],
    )
  }
  it('denies a new binding beyond discovery capacity without changing existing bindings', async () => {
    await fillBindings(10000)
    const attempt = await begin()
    expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'failed' })
    expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('10000')
  })
  it('preserves an existing reconnect at discovery capacity', async () => {
    await service.poll(actor, (await begin()).id)
    await fillBindings(9999)
    expect(await service.poll(actor, (await begin()).id)).toMatchObject({ status: 'connected' })
    expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('10000')
  })
  it('denies reactivation beyond discovery capacity without changing the disabled generation', async () => {
    await service.poll(actor, (await begin()).id)
    await db.query("UPDATE ci_installation_binding SET state='disabled',generation=2")
    await fillBindings(10000)
    expect(await service.poll(actor, (await begin()).id)).toMatchObject({ status: 'failed' })
    expect(
      (await db.query('SELECT state,generation FROM ci_installation_binding WHERE installation_id=123'))[0],
    ).toEqual({ state: 'disabled', generation: '2' })
  })
  it('admits only one concurrent tenant into the final discovery slot', async () => {
    await settings.ensure(db.manager, otherOrg)
    await fillBindings(9999)
    github.verifyUserInstallation.mockImplementation(async (_token, login) => ({
      installationId: login === 'alice' ? 123 : 124,
      accountId: login === 'alice' ? 456 : 457,
      accountLogin: login,
      accountType: 'User',
    }))
    const other = { organizationId: otherOrg, userId: 'other-owner' }
    const first = await begin()
    const second = await begin(other, { ...input, github_account: 'bob' })
    const responses = await Promise.all([service.poll(actor, first.id), service.poll(other, second.id)])
    expect(responses.map((response) => response.status).sort()).toEqual(['connected', 'failed'])
    expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('10000')
  })
  async function accountSession() {
    const personal = { accountId: 456, accountLogin: 'alice', accountType: 'User' as const }
    const team = { accountId: 789, accountLogin: 'team', accountType: 'Organization' as const }
    const installed = new Map([
      [456, 123],
      [789, 321],
    ])
    const identity = {
      ...github,
      clientId: 'identity-client',
      webSettings: () => ({
        clientId: 'identity-client',
        redirectUri: 'https://console.test/settings/ci/callback',
        authorizationSettingsUrl: 'https://github.com/settings/connections/applications/identity-client',
      }),
    }
    const orgApp = {
      ...github,
      clientId: 'org-client',
      accountType: 'Organization',
      settings: () => ({ clientId: 'org-client', installationUrl: 'https://github.com/apps/org-ci/installations/new' }),
    }
    github.identity.mockReturnValue(identity)
    github.authorizationApp.mockImplementation((client) => (client === 'identity-client' ? identity : github))
    github.isIdentityClient.mockImplementation((client) => client === 'identity-client')
    github.forType.mockImplementation((type) => (type === 'Organization' ? orgApp : github))
    github.byClientId.mockImplementation((client) => (client === 'org-client' ? orgApp : github))
    github.ownedAccounts.mockResolvedValue({ user: personal, accounts: [personal, team] })
    github.installationFor.mockImplementation(async (account) =>
      installed.has(account.accountId) ? { ...account, installationId: installed.get(account.accountId) } : null,
    )
    github.availableAccounts.mockImplementation(async () => ({
      user: personal,
      accounts: [personal, team].map((account) => ({
        ...account,
        clientId: account.accountType === 'User' ? 'app-client' : 'org-client',
        installationId: installed.get(account.accountId) ?? null,
      })),
    }))
    const attempt = await web()
    await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })
    return { attempt, installed }
  }
  it.each(['current', 'cancelled', 'owner-revoked', 'foreign-account', 'foreign-owner'])(
    'bounds grant repository reads to the owned account and rechecks the live grant: %s',
    async (scenario) => {
      const { attempt } = await accountSession()
      github.repositoryPage.mockReset().mockImplementation(async () => {
        if (scenario === 'cancelled') await service.cancel(actor, attempt.id)
        if (scenario === 'owner-revoked')
          await db.query('DELETE FROM organization_user WHERE "userId"=$1', [actor.userId])
        return { repositories: [], total: 0, page: 1 }
      })
      const result = service.repositories(
        scenario === 'foreign-owner' ? { ...actor, userId: 'other-owner' } : actor,
        attempt.id,
        scenario === 'foreign-account' ? 999 : 789,
        1,
        25,
      )
      if (scenario === 'current') {
        await expect(result).resolves.toMatchObject({ total: 0 })
        expect(github.repositoryPage).toHaveBeenCalledWith(
          'org-client',
          { installationId: 321, accountId: 789, accountLogin: 'team', accountType: 'Organization' },
          1,
          25,
        )
      } else await expect(result).rejects.toThrow()
      if (scenario.startsWith('foreign')) expect(github.repositoryPage).not.toHaveBeenCalled()
    },
  )
  it.each(['ownedAccounts', 'installationFor'])(
    'retains a bounded selection grant after transient %s failure',
    async (method) => {
      const { attempt } = await accountSession()
      const [before] = await db.query('SELECT expires_at FROM ci_connect_attempt WHERE id=$1', [attempt.id])
      github[method].mockRejectedValueOnce(new BadGatewayException('GitHub unavailable'))
      await expect(
        service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false }),
      ).rejects.toThrow('GitHub unavailable')
      const [row] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
      expect(row.state).toBe('selecting')
      expect(row.expires_at).toEqual(before.expires_at)
      expect(row.oauth_token_ciphertext).toBeTruthy()
      expect(row.lease_id).toBeNull()
      const result = await service.selectAccount(actor, attempt.id, {
        account_id: 789,
        allow_private_repositories: false,
      })
      expect(result.accounts.find((account) => account.account_id === 789).connected).toBe(true)
    },
  )
  it('connects two owned accounts under one bounded OAuth session with separate CI App bindings', async () => {
    const { attempt } = await accountSession()
    const [before] = await db.query('SELECT expires_at FROM ci_connect_attempt WHERE id=$1', [attempt.id])
    const first = await service.selectAccount(actor, attempt.id, { account_id: 456, allow_private_repositories: false })
    expect(first.accounts.find((account) => account.account_id === 456).connected).toBe(true)
    const second = await service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: true })
    expect(second.accounts.every((account) => account.connected)).toBe(true)
    const bindings = await db.query(
      'SELECT app_client_id,account_type,allow_private FROM ci_installation_binding ORDER BY app_client_id',
    )
    expect(bindings).toEqual([
      { app_client_id: 'app-client', account_type: 'User', allow_private: false },
      { app_client_id: 'org-client', account_type: 'Organization', allow_private: true },
    ])
    const [row] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
    expect(row.app_client_id).toBe('identity-client')
    expect(row.state).toBe('selecting')
    expect(row.expires_at).toEqual(before.expires_at)
    expect(row.oauth_token_ciphertext).toBeTruthy()
    expect(row.web_target_ciphertext).toBeNull()
    await service.cancel(actor, attempt.id)
    expect(
      (await db.query('SELECT oauth_token_ciphertext FROM ci_connect_attempt WHERE id=$1', [attempt.id]))[0]
        .oauth_token_ciphertext,
    ).toBeNull()
    expect(await db.query('SELECT id FROM ci_installation_binding')).toHaveLength(2)
  })
  it('resumes a missing installation with fresh target state and auto-binds only its matching Org App', async () => {
    const { attempt, installed } = await accountSession()
    installed.delete(789)
    const result = await service.selectAccount(actor, attempt.id, {
      account_id: 789,
      allow_private_repositories: false,
    })
    expect(result.status).toBe('installation_required')
    const url = new URL(result.installation_url),
      state = url.searchParams.get('state')!
    expect(url.pathname).toBe('/apps/org-ci/installations/new/permissions')
    expect(url.searchParams.get('target_id')).toBe('789')
    expect(url.searchParams.get('target_type')).toBe('Organization')
    expect(state).not.toBe(attempt.state)
    expect((await service.getWeb(actor, attempt.id)).installation_url).toBe(url.href)
    await expect(service.completeInstallation(actor, attempt.id, 321, attempt.state)).rejects.toThrow('state mismatch')
    installed.set(789, 321)
    const completed = await service.completeInstallation(actor, attempt.id, 321, state)
    expect(completed.accounts.find((account) => account.account_id === 789).connected).toBe(true)
    expect((await db.query('SELECT app_client_id FROM ci_installation_binding'))[0].app_client_id).toBe('org-client')
    await expect(service.completeInstallation(actor, attempt.id, 321, state)).rejects.toThrow('No pending')
  })
  it('targets the selected personal account on the installation permissions page', async () => {
    const { attempt, installed } = await accountSession()
    installed.delete(456)
    const result = await service.selectAccount(actor, attempt.id, { account_id: 456, allow_private_repositories: true })
    const url = new URL(result.installation_url)
    expect(url.pathname).toBe('/apps/example/installations/new/permissions')
    expect(url.searchParams.get('target_id')).toBe('456')
    expect(url.searchParams.get('target_type')).toBe('User')
    expect((await service.getWeb(actor, attempt.id)).installation_url).toBe(url.href)
  })
  it.each(['ciphertext', 'shape', 'missing-verifier'])(
    'rejects unusable persisted browser credentials: %s',
    async (scenario) => {
      if (scenario === 'missing-verifier') {
        const attempt = await web()
        await db.query('UPDATE ci_connect_attempt SET oauth_verifier_ciphertext=NULL WHERE id=$1', [attempt.id])
        await expect(
          service.completeWeb(actor, attempt.id, { code: 'code', state: attempt.state }),
        ).resolves.toMatchObject({ status: 'failed' })
        expect(github.exchangeWeb).not.toHaveBeenCalled()
        return
      }
      const { attempt, installed } = await accountSession()
      installed.delete(789)
      await service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false })
      const [row] = await db.query('SELECT * FROM ci_connect_attempt WHERE id=$1', [attempt.id])
      const aad = JSON.stringify([row.id, row.user_id, row.organization_id])
      const ciphertext =
        scenario === 'shape'
          ? secrets.seal(JSON.stringify({}), aad + ':web-target:' + row.app_client_id)
          : 'invalid-ciphertext'
      await db.query('UPDATE ci_connect_attempt SET web_target_ciphertext=$2 WHERE id=$1', [attempt.id, ciphertext])
      await expect(service.getWeb(actor, attempt.id)).rejects.toThrow(
        scenario === 'shape' ? 'Invalid GitHub installation context' : 'context unavailable',
      )
    },
  )
  it.each(['owner-revoked', 'wrong-installation', 'wrong-account'])(
    'denies installation completion after %s',
    async (scenario) => {
      const { attempt, installed } = await accountSession()
      installed.delete(789)
      const selected = await service.selectAccount(actor, attempt.id, {
        account_id: 789,
        allow_private_repositories: false,
      })
      const state = new URL(selected.installation_url).searchParams.get('state')!
      installed.set(789, 321)
      if (scenario === 'owner-revoked')
        github.ownedAccounts.mockResolvedValue({
          user: { accountId: 456, accountLogin: 'alice', accountType: 'User' },
          accounts: [],
        })
      if (scenario === 'wrong-account')
        github.installationFor.mockResolvedValue({
          installationId: 321,
          accountId: 999,
          accountLogin: 'other',
          accountType: 'Organization',
        })
      await expect(
        service.completeInstallation(actor, attempt.id, scenario === 'wrong-installation' ? 777 : 321, state),
      ).rejects.toThrow()
      expect(await db.query('SELECT id FROM ci_installation_binding')).toHaveLength(0)
      expect(
        (
          await db.query(
            'SELECT state,oauth_token_ciphertext,web_target_ciphertext FROM ci_connect_attempt WHERE id=$1',
            [attempt.id],
          )
        )[0],
      ).toEqual({ state: 'failed', oauth_token_ciphertext: null, web_target_ciphertext: null })
    },
  )
  it('fences a cross-App Delete while account verification is paused and preserves independent bindings', async () => {
    const { attempt } = await accountSession()
    await service.selectAccount(actor, attempt.id, { account_id: 456, allow_private_repositories: false })
    await service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false })
    const [binding] = await db.query("SELECT id FROM ci_installation_binding WHERE account_type='Organization'")
    const [wake] = await native.state.read(['wake/321/0'])
    const next = await web()
    await service.completeWeb(actor, next.id, { code: 'web-code', state: next.state })
    let entered!: () => void, release!: () => void
    const reached = new Promise<void>((resolve) => {
        entered = resolve
      }),
      paused = new Promise<void>((resolve) => {
        release = resolve
      })
    github.installationFor.mockImplementationOnce(async (account) => {
      entered()
      await paused
      return { ...account, installationId: 321 }
    })
    const choosing = service.selectAccount(actor, next.id, { account_id: 789, allow_private_repositories: false })
    await reached
    try {
      await settings.deleteConnection(actor, binding.id)
    } finally {
      release()
    }
    expect((await choosing).status).toBe('cancelled')
    expect((await db.query('SELECT state FROM ci_installation_binding WHERE id=$1', [binding.id]))[0].state).toBe(
      'disabled',
    )
    expect((await settings.get(actor)).connections.map((row) => row.github_account)).toEqual(['alice'])
    const rows = await db.query(
      'SELECT state,oauth_token_ciphertext,web_target_ciphertext,lease_id FROM ci_connect_attempt WHERE id=ANY($1::uuid[])',
      [[attempt.id, next.id]],
    )
    expect(rows).toEqual([
      expect.objectContaining({
        state: 'cancelled',
        oauth_token_ciphertext: null,
        web_target_ciphertext: null,
        lease_id: null,
      }),
      expect.objectContaining({
        state: 'cancelled',
        oauth_token_ciphertext: null,
        web_target_ciphertext: null,
        lease_id: null,
      }),
    ])
    expect((await native.state.read(['wake/321/0']))[0].version).toBe(wake.version)
    const fresh = await web()
    await service.completeWeb(actor, fresh.id, { code: 'web-code', state: fresh.state })
    expect(
      (
        await service.selectAccount(actor, fresh.id, { account_id: 789, allow_private_repositories: false })
      ).accounts.find((account) => account.account_id === 789).connected,
    ).toBe(true)
  })
  it('rolls back target context without damaging a pre-existing Device Flow attempt', async () => {
    const device = await begin()
    const { attempt, installed } = await accountSession()
    installed.delete(789)
    await service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false })
    const runner = db.createQueryRunner()
    try {
      await new AddCiWebTarget1794000000000().down(runner)
      const [row] = await db.query('SELECT state,oauth_token_ciphertext,lease_id FROM ci_connect_attempt WHERE id=$1', [
        attempt.id,
      ])
      expect(row).toEqual({ state: 'failed', oauth_token_ciphertext: null, lease_id: null })
      expect(
        (await db.query('SELECT device_ciphertext FROM ci_connect_attempt WHERE id=$1', [device.id]))[0]
          .device_ciphertext,
      ).toBeTruthy()
    } finally {
      await new AddCiWebTarget1794000000000().up(runner)
      await runner.release()
    }
    expect((await service.poll(actor, device.id)).status).toBe('connected')
  })
  it('expires abandoned installation context and clears it on the next start', async () => {
    const { attempt, installed } = await accountSession()
    installed.delete(789)
    await service.selectAccount(actor, attempt.id, { account_id: 789, allow_private_repositories: false })
    await db.query(
      "UPDATE ci_connect_attempt SET state='polling',oauth_token_ciphertext=NULL,lease_id=$2,lease_until=now()+interval '1 minute',expires_at=now()-interval '1 second' WHERE id=$1",
      [attempt.id, randomUUID()],
    )
    await web()
    expect(
      (
        await db.query(
          'SELECT state,oauth_token_ciphertext,web_target_ciphertext FROM ci_connect_attempt WHERE id=$1',
          [attempt.id],
        )
      )[0],
    ).toEqual({ state: 'expired', oauth_token_ciphertext: null, web_target_ciphertext: null })
    expect((await service.getWeb(actor, attempt.id)).status).toBe('expired')
  })
  it('discovers owned organizations independently of the identity App installation inventory', async () => {
    const attempt = await web()
    github.availableInstallations.mockResolvedValue([])
    github.isIdentityClient.mockReturnValue(true)
    github.availableAccounts.mockResolvedValue({
      user: { accountId: 456, accountLogin: 'alice', accountType: 'User' },
      accounts: [
        {
          accountId: 789,
          accountLogin: 'team',
          accountType: 'Organization',
          installationId: 321,
          clientId: 'org-client',
        },
      ],
    })
    const result = await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })
    expect(result.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: 789, github_account: 'team', account_type: 'Organization' }),
      ]),
    )
  })
  it('deletion cancels browser authorization issued by a different App', async () => {
    const first = await begin()
    await service.poll(actor, first.id)
    const [binding] = await db.query('SELECT id FROM ci_installation_binding')
    const attempt = await web()
    await service.completeWeb(actor, attempt.id, { code: 'web-code', state: attempt.state })
    await db.query('UPDATE ci_connect_attempt SET app_client_id=$2 WHERE id=$1', [attempt.id, 'identity-client'])
    await settings.deleteConnection(actor, binding.id)
    const [row] = await db.query('SELECT state,oauth_token_ciphertext,lease_id FROM ci_connect_attempt WHERE id=$1', [
      attempt.id,
    ])
    expect(row).toEqual({ state: 'cancelled', oauth_token_ciphertext: null, lease_id: null })
  })
  it('deletion cancels a pending verified connect before it can reactivate the binding', async () => {
    const first = await begin()
    await service.poll(actor, first.id)
    const [binding] = await db.query('SELECT id FROM ci_installation_binding')
    const attempt = await begin()
    const verified = github.verifyUserInstallation.getMockImplementation()!
    let entered!: () => void, resume!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    github.verifyUserInstallation.mockImplementationOnce(async (...args) => {
      entered()
      await paused
      return verified(...args)
    })
    const polling = service.poll(actor, attempt.id)
    await reached
    try {
      await settings.deleteConnection(actor, binding.id)
    } finally {
      resume()
    }
    expect(await polling).toMatchObject({ status: 'cancelled' })
    expect(
      await db.query('SELECT state,device_ciphertext,oauth_token_ciphertext FROM ci_connect_attempt WHERE id=$1', [
        attempt.id,
      ]),
    ).toEqual([{ state: 'cancelled', device_ciphertext: null, oauth_token_ciphertext: null }])
    expect((await settings.get(actor)).connections).toEqual([])
    const next = await begin()
    expect(await service.poll(actor, next.id)).toMatchObject({ status: 'connected' })
    expect((await settings.get(actor)).connections).toHaveLength(1)
  })
  it('retries the inventory wake when a concurrent scheduler settles the captured version', async () => {
    await priorInventoryEvent()
    const first = await begin()
    expect(await service.poll(actor, first.id)).toMatchObject({ status: 'connected' })
    const [old] = await native.state.read(['wake/123/0']),
      lease = (await native.state.acquire(randomUUID(), 30000))!
    const inside = native.inside.bind(native)
    let settled = false
    const wrapped = jest.spyOn(native, 'inside').mockImplementation((tx) => {
      const state = inside(tx),
        read = state.read.bind(state)
      jest.spyOn(state, 'read').mockImplementation(async (keys: readonly string[]) => {
        const rows = await read(keys)
        if (!settled && keys.length === 1 && keys[0] === 'wake/123/0' && rows.length) {
          settled = true
          await native.state.commit(lease, [{ key: rows[0].key, expected: rows[0].version }])
        }
        return rows
      })
      return state
    })
    try {
      const second = await begin()
      expect(await service.poll(actor, second.id)).toMatchObject({ status: 'connected' })
      const [current] = await native.state.read(['wake/123/0'])
      expect(current.version).not.toBe(old.version)
      expect(current.payload).toEqual(old.payload)
      expect(settled).toBe(true)
    } finally {
      wrapped.mockRestore()
    }
  })
  it('does not overwrite an inventory wake whose original account identity was corrupted', async () => {
    await priorInventoryEvent()
    const first = await begin()
    const result = await service.poll(actor, first.id)
    expect(result).toMatchObject({ status: 'connected' })
    const [old] = await native.state.read(['wake/123/0'])
    await native.state.ingest([
      { key: old.key, expected: old.version, payload: { installationId: 123, accountId: 999, repositoryId: 0 } },
    ])
    const second = await begin()
    expect(await service.poll(actor, second.id)).toMatchObject({ status: 'failed' })
    expect((await db.query('SELECT id FROM ci_installation_binding'))[0].id).toBe((result as any).binding_id)
    expect((await native.state.read(['wake/123/0']))[0].payload).toMatchObject({ accountId: 999 })
  })
  it('does not let unauthorized actors reserve or read an installation', async () => {
    await expect(service.start({ organizationId: org, userId: '' }, input)).rejects.toThrow()
    const attempt = await begin()
    await expect(service.poll({ organizationId: otherOrg, userId: actor.userId }, attempt.id)).rejects.toThrow(
      'not found',
    )
    await expect(service.cancel({ organizationId: org, userId: 'other' }, attempt.id)).rejects.toThrow('not found')
    expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('0')
  })
  it('serializes simultaneous polls and never binds one installation to two organizations', async () => {
    const first = await begin(),
      second = await begin({ organizationId: otherOrg, userId: 'other-owner' })
    const results = await Promise.all([
      service.poll(actor, first.id),
      service.poll({ organizationId: otherOrg, userId: 'other-owner' }, second.id),
    ])
    expect(results.filter((r) => r.status === 'connected')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'failed')).toHaveLength(1)
    expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('1')
    const third = await begin()
    await Promise.all(Array.from({ length: 5 }, () => service.poll(actor, third.id)))
    expect(github.pollDevice).toHaveBeenCalledTimes(3)
  })
  it('same owner is idempotent but public-policy expansion cannot overwrite a binding', async () => {
    const first = await begin()
    const bound = await service.poll(actor, first.id)
    const second = await begin()
    expect(await service.poll(actor, second.id)).toMatchObject({
      status: 'connected',
      binding_id: (bound as any).binding_id,
    })
    const expanded = await begin(actor, { ...input, allow_private_repositories: true })
    expect(await service.poll(actor, expanded.id)).toMatchObject({ status: 'failed' })
    expect((await db.query('SELECT allow_private FROM ci_installation_binding'))[0].allow_private).toBe(false)
  })
  it('cancellation wins against an already exchanged token before binding commits', async () => {
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    github.verifyUserInstallation.mockImplementation(async () => {
      entered()
      await blocked
      return { installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' }
    })
    const attempt = await begin()
    const polling = service.poll(actor, attempt.id)
    await waiting
    expect(await service.cancel(actor, attempt.id)).toMatchObject({ status: 'cancelled' })
    release()
    expect(await polling).toMatchObject({ status: 'cancelled' })
    expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('0')
  })
  it('honors pending, cumulative slow_down, expiry and interrupted token exchange', async () => {
    github.pollDevice.mockResolvedValue({ error: 'slow_down' })
    const attempt = await begin()
    expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'pending', interval: 10 })
    await service.poll(actor, attempt.id)
    expect(github.pollDevice).toHaveBeenCalledTimes(1)
    await db.query("UPDATE ci_connect_attempt SET next_poll_at=now()-interval '1 second' WHERE id=$1", [attempt.id])
    expect(await service.poll(actor, attempt.id)).toMatchObject({ interval: 15 })
    await db.query("UPDATE ci_connect_attempt SET expires_at=now()-interval '1 second' WHERE id=$1", [attempt.id])
    expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'expired' })
    const interrupted = await begin()
    await db.query(
      "UPDATE ci_connect_attempt SET state='polling',lease_id=$2,lease_until=now()-interval '1 second' WHERE id=$1",
      [interrupted.id, randomUUID()],
    )
    expect(await service.poll(actor, interrupted.id)).toMatchObject({ status: 'failed' })
  })
  it('allows organization deletion after pending, failed and completed connect attempts', async () => {
    for (const outcome of ['pending', 'failed', 'done']) {
      const temporaryOrg = randomUUID()
      await db.query('INSERT INTO organization VALUES ($1)', [temporaryOrg])
      await db.query(`INSERT INTO organization_user VALUES ($1,'temporary-owner','owner')`, [temporaryOrg])
      const who = { organizationId: temporaryOrg, userId: 'temporary-owner' }
      const attempt = await begin(who)
      if (outcome === 'failed') {
        github.pollDevice.mockResolvedValueOnce({ error: 'access_denied' })
        expect(await service.poll(who, attempt.id)).toMatchObject({ status: 'failed' })
      } else if (outcome === 'done') {
        expect(await service.poll(who, attempt.id)).toMatchObject({ status: 'connected' })
      }
      await expect(db.query('DELETE FROM organization WHERE id=$1', [temporaryOrg])).resolves.toBeDefined()
      expect(
        (await db.query('SELECT count(*) FROM ci_connect_attempt WHERE organization_id=$1', [temporaryOrg]))[0].count,
      ).toBe('0')
      expect(
        (await db.query('SELECT count(*) FROM ci_installation_binding WHERE organization_id=$1', [temporaryOrg]))[0]
          .count,
      ).toBe('0')
    }
  })
  it('requires a fresh device grant after installation-required or verification failure', async () => {
    for (const error of [new CiInstallationRequired(), new Error('upstream unavailable')]) {
      github.verifyUserInstallation.mockRejectedValue(error)
      const attempt = await begin()
      const expected = error instanceof CiInstallationRequired ? 'installation_required' : 'failed'
      expect(await service.poll(actor, attempt.id)).toMatchObject({ status: expected })
      const calls = github.pollDevice.mock.calls.length
      expect(await service.poll(actor, attempt.id)).toMatchObject({ status: expected })
      expect(github.pollDevice).toHaveBeenCalledTimes(calls)
      expect(
        (await db.query('SELECT device_ciphertext FROM ci_connect_attempt WHERE id=$1', [attempt.id]))[0]
          .device_ciphertext,
      ).toBeNull()
    }
  })
  it.each(['owner-removed', 'owner-demoted', 'user-deleted', 'admin-demoted'])(
    'CI commit authority rejects %s during GitHub verification',
    async (change) => {
      if (change === 'admin-demoted') await db.query(`UPDATE "user" SET role='admin';DELETE FROM organization_user`)
      const attempt = await begin()
      github.verifyUserInstallation.mockImplementationOnce(async () => {
        const sql = {
          'owner-removed': 'DELETE FROM organization_user',
          'owner-demoted': "UPDATE organization_user SET role='member'",
          'user-deleted': 'DELETE FROM "user"',
          'admin-demoted': `UPDATE "user" SET role='user'`,
        }[change]
        await db.query(sql!)
        return { installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' }
      })
      expect(await service.poll(actor, attempt.id)).toMatchObject({ status: 'failed' })
      expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('0')
    },
  )
  const keyHash = 'a'.repeat(64)
  const keyedActor = { ...actor, apiKey: { keyHash } }
  async function keyActor() {
    await db.query(
      `INSERT INTO api_key VALUES ($1,$2,$3,ARRAY['write:boxes','delete:boxes'],clock_timestamp()+interval '1 hour')`,
      [keyHash, org, actor.userId],
    )
    return keyedActor
  }
  it.each(['deleted', 'expired', 'replaced', 'permissions', 'organization', 'user'])(
    'CI commit authority rejects a Key %s during GitHub verification',
    async (change) => {
      const who = await keyActor(),
        attempt = await begin(who)
      github.verifyUserInstallation.mockImplementationOnce(async () => {
        const sql = {
          deleted: 'DELETE FROM api_key',
          expired: `UPDATE api_key SET "expiresAt"=clock_timestamp()-interval '1 second'`,
          replaced: `UPDATE api_key SET "keyHash"=repeat('b',64)`,
          permissions: `UPDATE api_key SET permissions=ARRAY['write:boxes']`,
          organization: `UPDATE api_key SET "organizationId"='${otherOrg}'`,
          user: `UPDATE api_key SET "userId"='other-owner'`,
        }[change]
        await db.query(sql!)
        return { installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' }
      })
      expect(await service.poll(who, attempt.id)).toMatchObject({ status: 'failed' })
      expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('0')
    },
  )
  it.each(['owner', 'admin', 'key', 'admin-key'])('CI commit authority accepts current %s authority', async (mode) => {
    const who = mode.includes('key') ? await keyActor() : actor
    if (mode.startsWith('admin')) await db.query(`UPDATE "user" SET role='admin';DELETE FROM organization_user`)
    const attempt = await begin(who)
    expect(await service.poll(who, attempt.id)).toMatchObject({ status: 'connected', listener_status: 'provisioning' })
  })
  async function awaitDatabase(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 1500
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('Database synchronization condition not reached')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  it.each(['attempt', 'lease', 'key'])(
    'CI commit authority rejects %s expiry while blocked on a real row lock',
    async (kind) => {
      const who = kind === 'key' ? await keyActor() : actor
      const attempt = await begin(who)
      const blocker = db.createQueryRunner()
      let entered!: () => void
      const locked = new Promise<void>((resolve) => {
        entered = resolve
      })
      let blockerPid: number
      github.verifyUserInstallation.mockImplementationOnce(async () => {
        const sql =
          kind === 'key'
            ? `UPDATE api_key SET "expiresAt"=clock_timestamp()+interval '350 milliseconds'`
            : `UPDATE ci_connect_attempt SET ${kind === 'attempt' ? 'expires_at' : 'lease_until'}=clock_timestamp()+interval '350 milliseconds' WHERE id=$1`
        await db.query(sql, kind === 'key' ? [] : [attempt.id])
        await blocker.startTransaction()
        blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid'))[0].pid
        await blocker.query('SELECT id FROM ci_connect_attempt WHERE id=$1 FOR UPDATE', [attempt.id])
        entered()
        return { installationId: 123, accountId: 456, accountLogin: 'alice', accountType: 'User' }
      })
      const polling = service.poll(who, attempt.id)
      try {
        await locked
        await awaitDatabase(async () =>
          Boolean(
            (
              await db.query(
                'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
                [blockerPid],
              )
            )[0].waiting,
          ),
        )
        await awaitDatabase(async () =>
          Boolean(
            (
              await db.query(
                kind === 'key'
                  ? `SELECT clock_timestamp()>"expiresAt" AS expired FROM api_key`
                  : `SELECT clock_timestamp()>${kind === 'attempt' ? 'expires_at' : 'lease_until'} AS expired FROM ci_connect_attempt WHERE id=$1`,
                kind === 'key' ? [] : [attempt.id],
              )
            )[0].expired,
          ),
        )
        await blocker.rollbackTransaction()
        expect(await polling).toMatchObject({ status: 'failed' })
        expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('0')
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction()
        await blocker.release()
        await polling
      }
    },
  )
  it('CI commit authority keeps ADMIN Key permissions bounded', async () => {
    const who = await keyActor()
    await db.query(
      `UPDATE "user" SET role='admin';DELETE FROM organization_user;UPDATE api_key SET permissions=ARRAY['write:boxes']`,
    )
    const attempt = await begin(who)
    expect(await service.poll(who, attempt.id)).toMatchObject({ status: 'failed' })
    expect((await db.query('SELECT count(*) FROM ci_installation_binding'))[0].count).toBe('0')
  })
  it.each(['user', 'membership', 'key'])(
    'CI commit authority holds %s until the binding transaction commits',
    async (kind) => {
      const who = kind === 'key' ? await keyActor() : actor
      const attempt = await begin(who)
      const blocker = db.createQueryRunner(),
        revoker = db.createQueryRunner()
      await db.query(`CREATE FUNCTION ci_pause_done() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA));RETURN NEW;END $$;
      CREATE TRIGGER ci_pause_done BEFORE UPDATE ON ci_connect_attempt
        FOR EACH ROW WHEN (NEW.state='done') EXECUTE FUNCTION ci_pause_done()`)
      await blocker.startTransaction()
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()))')
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid'))[0].pid
      const polling = service.poll(who, attempt.id)
      let mutation: Promise<unknown> | undefined
      try {
        await awaitDatabase(async () =>
          Boolean(
            (
              await db.query(
                'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
                [blockerPid],
              )
            )[0].waiting,
          ),
        )
        const bindPid = (
          await db.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blockerPid])
        )[0].pid
        await revoker.connect()
        const revokePid = (await revoker.query('SELECT pg_backend_pid() AS pid'))[0].pid
        let finished = false
        const sql = {
          user: 'DELETE FROM "user"',
          membership: 'DELETE FROM organization_user',
          key: 'DELETE FROM api_key',
        }[kind]
        mutation = revoker.query(sql!).then(() => {
          finished = true
        })
        await awaitDatabase(
          async () =>
            finished ||
            Boolean(
              (await db.query('SELECT $1=ANY(pg_blocking_pids($2)) AS waiting', [bindPid, revokePid]))[0].waiting,
            ),
        )
        expect(finished).toBe(false)
        await blocker.rollbackTransaction()
        expect(await polling).toMatchObject({ status: 'connected' })
        await mutation
        expect(finished).toBe(true)
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction()
        await polling
        await mutation
        await revoker.release()
        await blocker.release()
        await db.query('DROP TRIGGER ci_pause_done ON ci_connect_attempt;DROP FUNCTION ci_pause_done()')
      }
    },
  )
})
