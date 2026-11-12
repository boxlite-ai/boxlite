import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseBase } from 'mstage/config'
import { valuesOfGroup } from 'mstage/select-group'
import { EnvError } from 'mstage/env'
import { ApiEnvironmentError, BILLING_KEYS, STATUS_SYNC_KEYS, apiEnvironmentFrom } from '../src/api-environment.ts'
import type { GroupDeclaration } from '../src/env.ts'

const groups = (api: string[], secret?: string[]): GroupDeclaration => ({
  groups: { deploy: [], api, ...(secret ? { secret } : {}) },
  where: '/repo/mstage.config.json',
})

const base = { STACK_DOMAIN: 'dev.boxlite.ai', OIDC_ISSUER_BASE_URL: 'https://auth.dev.boxlite.ai' }

const assemble = (environment: Record<string, string | undefined>, declaration = groups([])) =>
  apiEnvironmentFrom({ environment, declaration, region: 'ap-southeast-1', stage: 'dev', home: 'aws' })

for (const home of ['aws', 'gcp'] as const) {
  for (const enabled of [undefined, 'false', 'true']) {
    test(`${home} delivers checkpoint admission ${enabled ?? '(unset)'} through the stage API group`, () => {
      const path = new URL('../../mstage.env.json', import.meta.url)
      const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
      const required = Object.fromEntries(
        declared.envSelectGroup
          .api!.filter((name) => !declared.envOptional.api!.includes(name))
          .map((name) => [name, 'fixture']),
      )
      const selected = valuesOfGroup({
        group: 'api',
        groups: declared.envSelectGroup,
        optional: declared.envOptional.api,
        where: path.pathname,
        values: { ...required, ...(enabled === undefined ? {} : { CHECKPOINTS_ENABLED: enabled }) },
      })
      const { environment, secrets } = apiEnvironmentFrom({
        environment: { ...base, ...selected },
        declaration: { groups: declared.envSelectGroup, optional: declared.envOptional, where: path.pathname },
        region: home === 'aws' ? 'us-east-1' : 'us-east1',
        stage: 'dev',
        home,
      })
      assert.equal(environment.CHECKPOINTS_ENABLED, enabled)
      assert.equal(Object.hasOwn(environment, 'CHECKPOINTS_ENABLED'), enabled !== undefined)
      assert.equal(Object.hasOwn(secrets, 'CHECKPOINTS_ENABLED'), false)
    })
  }
}

for (const home of ['aws', 'gcp'] as const) {
  test(`${home} delivers FILESTORE_INSTANCES through the stage API group`, () => {
    // The runner reads the resolved server/export from its dispatch, so this
    // value is the deployment's own placement record for Filestore instances
    // (PR boxlite-ai/boxlite#2608): absent on stages without the feature, a
    // JSON array when an operator provisions one.
    const path = new URL('../../mstage.env.json', import.meta.url)
    const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
    const required = Object.fromEntries(
      declared.envSelectGroup
        .api!.filter((name) => !declared.envOptional.api!.includes(name))
        .map((name) => [name, 'fixture']),
    )
    const instances = JSON.stringify([{ name: 'boxlite-dev-shared', server: '10.0.0.7', export: '/vol1' }])
    const selected = valuesOfGroup({
      group: 'api',
      groups: declared.envSelectGroup,
      optional: declared.envOptional.api,
      where: path.pathname,
      values: { ...required, FILESTORE_INSTANCES: instances },
    })
    const { environment, secrets } = apiEnvironmentFrom({
      environment: { ...base, ...selected },
      declaration: { groups: declared.envSelectGroup, optional: declared.envOptional, where: path.pathname },
      region: home === 'aws' ? 'us-east-1' : 'us-east1',
      stage: 'dev',
      home,
    })
    assert.equal(environment.FILESTORE_INSTANCES, instances)
    assert.equal(Object.hasOwn(secrets, 'FILESTORE_INSTANCES'), false)
  })

  test(`${home} omits FILESTORE_INSTANCES when the stage does not set it`, () => {
    const path = new URL('../../mstage.env.json', import.meta.url)
    const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
    const required = Object.fromEntries(
      declared.envSelectGroup
        .api!.filter((name) => !declared.envOptional.api!.includes(name))
        .map((name) => [name, 'fixture']),
    )
    const selected = valuesOfGroup({
      group: 'api',
      groups: declared.envSelectGroup,
      optional: declared.envOptional.api,
      where: path.pathname,
      values: { ...required },
    })
    const { environment } = apiEnvironmentFrom({
      environment: { ...base, ...selected },
      declaration: { groups: declared.envSelectGroup, optional: declared.envOptional, where: path.pathname },
      region: home === 'aws' ? 'us-east-1' : 'us-east1',
      stage: 'dev',
      home,
    })
    assert.equal(Object.hasOwn(environment, 'FILESTORE_INSTANCES'), false)
  })
}


for (const home of ['aws', 'gcp'] as const) {
  for (const minimum of [undefined, '1', '3', '63']) {
    test(`${home} delivers the platform subdomain minimum ${minimum ?? '(unset)'} from the stage group`, () => {
      const path = new URL('../../mstage.env.json', import.meta.url)
      const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
      const key = 'PLATFORM_SUBDOMAIN_MIN_LENGTH'
      const required = Object.fromEntries(
        declared.envSelectGroup.api!
          .filter((name) => name !== key && !declared.envOptional.api!.includes(name))
          .map((name) => [name, 'fixture']),
      )
      const selected = valuesOfGroup({
        group: 'api',
        groups: declared.envSelectGroup,
        optional: declared.envOptional.api,
        where: path.pathname,
        values: { ...required, ...(minimum === undefined ? {} : { [key]: minimum }) },
      })
      const { environment, secrets } = apiEnvironmentFrom({
        environment: { ...base, ...selected },
        declaration: { groups: declared.envSelectGroup, optional: declared.envOptional, where: path.pathname },
        region: home === 'aws' ? 'us-east-1' : 'us-east1',
        stage: 'dev',
        home,
      })
      assert.equal(environment[key], minimum)
      assert.equal(Object.hasOwn(environment, key), minimum !== undefined)
      assert.equal(Object.hasOwn(secrets, key), false)
    })
  }
}

test('PostHog events use the deployed stage on both clouds', () => {
  for (const home of ['aws', 'gcp'] as const) {
    const { environment } = apiEnvironmentFrom({
      environment: base, declaration: groups([]), region: 'us-east1', stage: 'dev', home,
    })
    assert.equal(environment.POSTHOG_ENVIRONMENT, 'dev', home)
  }
})

const ciSecrets = ['CI_GITHUB_APP_PRIVATE_KEY', 'CI_GITHUB_WEBHOOK_SECRET', 'CI_SECRET_ENCRYPTION_KEY']
const ciKeys = ['CI_GITHUB_APP_CLIENT_ID', 'CI_GITHUB_APP_SLUG', ...ciSecrets]
const ciValues = (home: 'aws' | 'gcp'): Record<string, string> => ({
  CI_GITHUB_APP_CLIENT_ID: 'test-client',
  CI_GITHUB_APP_SLUG: 'example-app',
  ...Object.fromEntries(
    ciSecrets.map((key, index) => [
      key,
      JSON.stringify({
        address:
          home === 'gcp'
            ? `projects/test-project/secrets/ci-${index}/versions/1`
            : `arn:aws:secretsmanager:us-east-1:123456789012:secret:ci-${index}`,
      }),
    ]),
  ),
})

test('browser connect is optional and carries its client secret only through a secret reference', () => {
  const key = 'CI_GITHUB_APP_CLIENT_SECRET'
  const input = {
    ...base,
    ...ciValues('gcp'),
    [key]: JSON.stringify({ address: 'projects/test-project/secrets/ci-oauth/versions/1' }),
  }
  const result = apiEnvironmentFrom({
    environment: input,
    declaration: groups([...ciKeys, key], [...ciSecrets, key]),
    region: 'us-east1',
    stage: 'dev',
    home: 'gcp',
  })
  assert.equal(result.environment[key], undefined)
  assert.equal(result.secrets[key], 'projects/test-project/secrets/ci-oauth/versions/1')
  assert.throws(
    () =>
      apiEnvironmentFrom({
        environment: { ...input, [key]: 'CONFIDENTIAL-DO-NOT-ECHO' },
        declaration: groups([...ciKeys, key], ciSecrets),
        region: 'us-east1',
        stage: 'dev',
        home: 'gcp',
      }),
    (error) => {
      assert.ok(error instanceof ApiEnvironmentError)
      assert.ok(!error.message.includes('CONFIDENTIAL-DO-NOT-ECHO'))
      return true
    },
  )
  const declared = parseBase(
    new URL('../../mstage.env.json', import.meta.url).pathname,
    readFileSync(new URL('../../mstage.env.json', import.meta.url), 'utf8'),
  )
  assert.ok(declared.envSelectGroup.api.includes(key))
  assert.ok(declared.envSelectGroup.secret.includes(key))
  assert.ok(declared.envOptional.api.includes(key))
})

test('the committed catalog carries optional CI fields and marks only its credentials as references', () => {
  const path = new URL('../../mstage.env.json', import.meta.url)
  const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
  for (const key of ciKeys) {
    assert.ok(declared.envSelectGroup.api.includes(key))
    assert.ok(declared.envOptional.api.includes(key))
    assert.equal(declared.envSelectGroup.secret.includes(key), ciSecrets.includes(key))
  }
})

for (const home of ['aws', 'gcp'] as const) {
  test(`${home} delivers CI credentials only as secret references`, () => {
    const input = ciValues(home)
    const result = apiEnvironmentFrom({
      environment: { ...base, ...input },
      declaration: groups(ciKeys, ciSecrets),
      region: 'us-east1',
      stage: 'dev',
      home,
    })
    assert.equal(result.environment.CI_GITHUB_APP_CLIENT_ID, input.CI_GITHUB_APP_CLIENT_ID)
    assert.equal(result.environment.CI_GITHUB_APP_SLUG, input.CI_GITHUB_APP_SLUG)
    for (const key of ciSecrets) {
      assert.equal(result.environment[key], undefined)
      assert.equal(result.secrets[key], JSON.parse(input[key]).address)
    }
  })
}

for (const key of ciSecrets) {
  test(`hosted CI rejects plaintext ${key} without echoing it`, () => {
    const input = { ...ciValues('aws'), [key]: 'CONFIDENTIAL-DO-NOT-ECHO' }
    assert.throws(
      () =>
        assemble(
          { ...base, ...input },
          groups(
            ciKeys,
            ciSecrets.filter((k) => k !== key),
          ),
        ),
      (error) => {
        assert.ok(error instanceof ApiEnvironmentError)
        assert.match(error.message, new RegExp(key))
        assert.ok(!error.message.includes(input[key]))
        return true
      },
    )
  })
}

for (const key of ciKeys) {
  test(`hosted CI refuses a partial configuration missing ${key}`, () => {
    const input = ciValues('aws')
    delete input[key]
    assert.throws(
      () =>
        assemble(
          { ...base, ...input },
          groups(
            ciKeys.filter((k) => k !== key),
            ciSecrets.filter((k) => k !== key),
          ),
        ),
      new RegExp(key),
    )
  })
}

test('a secret-reference client ID cannot silently leave the scheduler without background CPU', () => {
  const key = 'CI_GITHUB_APP_CLIENT_ID'
  assert.throws(
    () => assemble({ ...base, [key]: ciValues('aws').CI_GITHUB_APP_PRIVATE_KEY }, groups([key], [key])),
    /CI_GITHUB_APP_CLIENT_ID/,
  )
})

test('hosted CI refuses standalone file inputs', () => {
  const key = 'CI_GITHUB_APP_PRIVATE_KEY_FILE'
  assert.throws(() => assemble({ ...base, [key]: '/private/key.pem' }, groups([key])), /self-hosted file input/)
})

test('the declared API group delivers the organization invitation lifetime on both clouds', () => {
  const path = new URL('../../mstage.env.json', import.meta.url)
  const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
  const apiKeys = declared.envSelectGroup.api
  const optionalKeys = declared.envOptional.api
  assert.ok(apiKeys)
  assert.ok(optionalKeys)
  const required = Object.fromEntries(
    apiKeys.filter((key) => !optionalKeys.includes(key)).map((key) => [key, 'fixture']),
  )
  for (const home of ['aws', 'gcp'] as const) {
    const { environment } = apiEnvironmentFrom({
      environment: {
        ...base,
        ...required,
        ORGANIZATION_INVITATION_TTL_SECONDS: '3600',
      },
      declaration: { groups: declared.envSelectGroup, optional: declared.envOptional, where: path.pathname },
      region: 'us-east1',
      stage: 'dev',
      home,
    })
    assert.equal(environment.ORGANIZATION_INVITATION_TTL_SECONDS, '3600', home)
  }
})

test('the two dashboard origins are different on purpose, and both have a default', () => {
  // Static assets go through the CDN at the root domain; the dashboard's API
  // client talks to api.<domain> directly, because the CDN caps a WebSocket at
  // ten minutes and times an origin read out at sixty seconds.
  const { environment } = assemble(base)
  assert.equal(environment.DASHBOARD_URL, 'https://dev.boxlite.ai')
  assert.equal(environment.DASHBOARD_BASE_API_URL, 'https://api.dev.boxlite.ai')
  assert.notEqual(environment.DASHBOARD_URL, environment.DASHBOARD_BASE_API_URL)

  const overridden = assemble({ ...base, DASHBOARD_URL: 'https://console.example.com' })
  assert.equal(overridden.environment.DASHBOARD_URL, 'https://console.example.com')
})

test('a stage may serve its dashboard off the stage domain, and only the dashboard moves', () => {
  /*
   * prod keeps `boxlite.ai` for the marketing site, so the dashboard is at
   * `app.boxlite.ai` and the control plane at `api.boxlite.ai`. The control
   * plane is the half that must not follow: a runner is handed `api.<domain>`
   * at first boot, in a systemd unit an upgrade does not rewrite, and the
   * in-VPC private zone answers for that one name.
   */
  const { environment } = assemble({ ...base, DASHBOARD_DOMAIN: 'app.dev.boxlite.ai' })
  assert.equal(environment.DASHBOARD_URL, 'https://app.dev.boxlite.ai')
  assert.equal(environment.DASHBOARD_BASE_API_URL, 'https://api.dev.boxlite.ai')

  // The logout redirect lands the browser back on the origin it is already on,
  // which is the dashboard's rather than the control plane's.
  assert.equal(environment.OIDC_END_SESSION_ENDPOINT, 'https://app.dev.boxlite.ai/api/auth/end-session')

  // A stage that puts the dashboard behind something else still wins.
  const pinned = assemble({
    ...base,
    DASHBOARD_DOMAIN: 'app.dev.boxlite.ai',
    DASHBOARD_URL: 'https://console.example.com',
  })
  assert.equal(pinned.environment.DASHBOARD_URL, 'https://console.example.com')
})

test('the MCP resource defaults to /mcp on the control plane host, and a stage may pin its own', () => {
  // The URL an MCP client connects to is the OAuth resource (RFC 9728), so it
  // follows the API host rather than a value set by hand per stage.
  assert.equal(assemble(base).environment.MCP_RESOURCE_URL, 'https://api.dev.boxlite.ai/mcp')
  assert.equal(
    assemble({ ...base, DASHBOARD_DOMAIN: 'app.dev.boxlite.ai' }).environment.MCP_RESOURCE_URL,
    'https://api.dev.boxlite.ai/mcp',
  )
  assert.equal(
    assemble({ ...base, MCP_RESOURCE_URL: 'https://mcp.example.com/mcp' }).environment.MCP_RESOURCE_URL,
    'https://mcp.example.com/mcp',
  )
})

test('a dashboard host that is the control plane’s own is refused at the boundary', () => {
  /*
   * The two names become one Cloudflare record and one certificate each. Left
   * to the apply, the provider builds one of them and then fails on the other
   * with a resource collision, which names neither the setting nor the stage
   * that holds it.
   */
  assert.throws(() => assemble({ ...base, DASHBOARD_DOMAIN: 'api.dev.boxlite.ai' }), /control plane answers/)
})

test('an issuer is required, because a placeholder would let the stack look healthy', () => {
  assert.throws(() => assemble({ STACK_DOMAIN: 'dev.boxlite.ai' }), /OIDC_ISSUER_BASE_URL is required/)
  assert.throws(() => assemble({ OIDC_ISSUER_BASE_URL: 'https://auth' }), /STACK_DOMAIN is required/)
})

test('the management client is refused without the audience it needs', () => {
  // The one flag that is not derived from its credential: the audience is a
  // setting rather than a secret, so a stage that turned the feature on without
  // one would fail at its first account-link instead of at boot.
  assert.throws(
    () => assemble({ ...base, OIDC_MANAGEMENT_API_ENABLED: 'true' }),
    /OIDC_MANAGEMENT_API_AUDIENCE is required/,
  )
  const { environment } = assemble({
    ...base,
    OIDC_MANAGEMENT_API_ENABLED: 'true',
    OIDC_MANAGEMENT_API_AUDIENCE: 'https://auth.dev.boxlite.ai/api/v2/',
  })
  assert.equal(environment.OIDC_MANAGEMENT_API_ENABLED, 'true')
  assert.equal(environment.OIDC_MANAGEMENT_API_AUDIENCE, 'https://auth.dev.boxlite.ai/api/v2/')
})

test('a stage that names no billing service keeps the dashboard’s billing pages gated off', () => {
  const { environment } = assemble(base)
  assert.equal(environment.BILLING_API_URL, undefined)
  assert.equal(environment.USAGE_EXPORT_ENABLED, undefined, 'nothing to enable, so nothing said about it')
})

test('the usage export URL is derived from the billing origin rather than taken twice', () => {
  // The publisher appends /internal/usage-events, which the billing service
  // answers off its bare origin. Sending the billing base path would 404 every
  // batch, and a second setting is a second thing that can be pointed elsewhere.
  const { environment } = assemble(
    { ...base, BILLING_API_URL: 'https://commerce.example.com/api/billing', USAGE_EXPORT_TOKEN: 'token' },
    groups(['USAGE_EXPORT_TOKEN']),
  )
  assert.equal(environment.USAGE_EXPORT_URL, 'https://commerce.example.com')
  assert.equal(environment.USAGE_EXPORT_ENABLED, 'true')
  assert.equal(environment.USAGE_ALLOCATION_SNAPSHOT_ENABLED, 'true')
})

test('export is off until the credential arrives, whichever channel brings it', () => {
  // Derived from presence rather than from the value's text: a credential
  // delivered by reference is an ARN here, and asking whether an ARN is empty
  // would answer the wrong question. The API refuses to boot when export is on
  // without a token, so a stage pointed at a billing service and never given
  // the secret has to come up dark rather than crash-loop.
  const asValue = assemble(
    { ...base, BILLING_API_URL: 'https://commerce.example.com', USAGE_EXPORT_TOKEN: '' },
    groups(['USAGE_EXPORT_TOKEN']),
  )
  assert.equal(asValue.environment.USAGE_EXPORT_ENABLED, 'false')

  const asAddress = assemble(
    {
      ...base,
      BILLING_API_URL: 'https://commerce.example.com',
      // What a marked key holds in the store: an address, as mstage writes one.
      USAGE_EXPORT_TOKEN: JSON.stringify({
        address: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite/dev/usage-AbCdEf',
      }),
    },
    groups(['USAGE_EXPORT_TOKEN'], ['USAGE_EXPORT_TOKEN']),
  )
  assert.equal(asAddress.environment.USAGE_EXPORT_ENABLED, 'true', 'held is held, whichever channel carries it')
  assert.ok('USAGE_EXPORT_TOKEN' in asAddress.secrets, 'and it travels as an address, never as a value')
  assert.equal(asAddress.environment.USAGE_EXPORT_TOKEN, undefined)
})

test('a billing URL that is not a URL is refused where it is written, not where it is called', () => {
  assert.throws(() => assemble({ ...base, BILLING_API_URL: 'commerce.example.com' }), /must be an absolute URL/)
})

test('the status sync is gated on the alert source, and its own switch follows the credential', () => {
  const off = assemble(base)
  assert.equal(off.environment.INCIDENT_IO_ALERT_SOURCE_CONFIG_ID, undefined)

  // Empty rather than absent: a group names keys the store *must* hold, and an
  // empty value is how a store says "configured, and switched off".
  const dark = assemble(
    { ...base, INCIDENT_IO_ALERT_SOURCE_CONFIG_ID: 'src-1', INCIDENT_IO_TOKEN: '' },
    groups(['INCIDENT_IO_TOKEN']),
  )
  assert.equal(dark.environment.STATUS_SYNC_ENABLED, 'false')
  assert.equal(dark.environment.STATUS_SYNC_DEDUP_PREFIX, 'boxlite-dev', 'the per-stage identity is the stage name')

  const on = assemble(
    { ...base, INCIDENT_IO_ALERT_SOURCE_CONFIG_ID: 'src-1', INCIDENT_IO_TOKEN: 'token' },
    groups(['INCIDENT_IO_TOKEN']),
  )
  assert.equal(on.environment.STATUS_SYNC_ENABLED, 'true')
})

test('the system image registry is all or nothing, gated on the URL', () => {
  const without = assemble(base)
  assert.equal(without.environment.BOXLITE_SYSTEM_SOURCE_REGISTRY_NAME, undefined)

  const { environment } = assemble({ ...base, BOXLITE_SYSTEM_SOURCE_REGISTRY_URL: 'https://ghcr.io' })
  assert.equal(environment.BOXLITE_SYSTEM_SOURCE_REGISTRY_URL, 'https://ghcr.io')
  assert.equal(environment.BOXLITE_SYSTEM_SOURCE_REGISTRY_NAME, 'BoxLite System Source Registry')
})

test('a flag that is neither true nor false is refused here rather than at the service’s boot', () => {
  assert.throws(() => assemble({ ...base, OIDC_MANAGEMENT_API_ENABLED: 'yes' }), /must be true or false/)
  assert.throws(
    () => assemble({ ...base, OIDC_MANAGEMENT_API_ENABLED: 'yes' }),
    (error) => error instanceof ApiEnvironmentError,
  )
})

/** A stage key read through one of this module's accessors, by literal name. */
const STAGE_READ = /\b(?:optional|flag|held|passthrough)\((?:[a-z]+,\s*)?'([A-Z][A-Z0-9_]*)'/g

/**
 * Every key the module reads, found from its calls rather than listed — the way
 * `deployment/key-policy.test.ts` scans the incumbent stack. Comments are
 * stripped first, so a key named in prose is not a key read.
 */
const keysReadBy = (url: URL): Set<string> => {
  const live = readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  return new Set([...live.matchAll(STAGE_READ)].map((match) => match[1] as string))
}

test('every key this module reads is one the store is declared to fetch', () => {
  // A name this module reads but no group names would read as "not configured"
  // on every deploy, with nothing saying why. Scanned, not listed: a list only
  // covers the keys someone remembered to put on it.
  //
  // Read through mstage's own parser rather than off the raw JSON: a group may
  // be written as a bare array or as required/optional, and a test that
  // flattened only one shape would silently stop checking the other.
  const path = new URL('../../mstage.env.json', import.meta.url)
  const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
  const fetched = new Set(Object.values(declared.envSelectGroup).flat())
  const read = keysReadBy(new URL('../src/api-environment.ts', import.meta.url))
  // The scan has to keep seeing how the module reads, or it passes by finding nothing.
  for (const key of [...BILLING_KEYS, ...STATUS_SYNC_KEYS]) {
    assert.ok(read.has(key), `the scan no longer finds ${key}; update STAGE_READ`)
  }
  for (const key of read) {
    assert.ok(fetched.has(key), `${key} is read by api-environment.ts but no group in mstage.env.json fetches it`)
  }
})

test('nothing a single deploy decides is demanded of the store', () => {
  // An image tag and a runner binary's checksum are different on every run, so
  // a store can never hold them: naming them in a group makes every deploy fail
  // on a key nobody could have seeded. They reach both engines through the
  // process environment, which is where the workflow puts them.
  const path = new URL('../../mstage.env.json', import.meta.url)
  const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
  const named = new Set(Object.values(declared.envSelectGroup).flat())
  for (const key of [
    'BOXLITE_IMAGE_TAG',
    'BOXLITE_RUNNER_BINARY_URL',
    'BOXLITE_RUNNER_BINARY_SHA256',
    'BOXLITE_RUNNER_BINARY_SOURCE',
    // The version too, and that is the point rather than an omission: the
    // runner binary is the commit's, resolved by `stack/runner-binary.ts` from
    // the workspace version. A store that held it would pin a fleet to whatever
    // was current the day someone seeded it, and drift from the commit the rest
    // of the deploy is shipping.
    'RUNNER_VERSION',
  ]) {
    assert.ok(!named.has(key), `${key} is decided per deploy and cannot live in the store`)
  }
})

test('the deploy group demands only what a deploy cannot run without', () => {
  // The rest is optional, and that split is the whole point: a required list
  // that swept in every feature flag would force a stage to seed forty empty
  // strings to say nothing at all.
  const path = new URL('../../mstage.env.json', import.meta.url)
  const declared = parseBase(path.pathname, readFileSync(path, 'utf8'))
  assert.deepEqual(
    declared.envSelectGroup.deploy!.filter((key) => !declared.envOptional.deploy!.includes(key)).sort(),
    [
      'BOXLITE_STAGE_CONFIG_DIGEST',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_DEFAULT_ACCOUNT_ID',
      'CLOUDFLARE_ZONE_ID',
      // IAM_PERMISSIONS_BOUNDARY_STAGE is optional, not absent: it names an AWS
      // permissions boundary that only the incumbent SST path reads
      // (`deployment/environment.ts`), and demanding it of every stage means
      // demanding an AWS concept of a stage that has no AWS in its deploy path
      // at all. That path still refuses when it is genuinely missing.
      'OIDC_ISSUER_BASE_URL',
      'PROXY_DOMAIN',
      'STACK_DOMAIN',
    ],
  )
})

test('Organization App secrets use the workload channel with a distinct identity and the shared anchor', () => {
  const orgSecrets = [
    'CI_GITHUB_ORG_APP_PRIVATE_KEY',
    'CI_GITHUB_ORG_WEBHOOK_SECRET',
    'CI_GITHUB_ORG_APP_CLIENT_SECRET',
  ]
  const orgKeys = ['CI_GITHUB_ORG_APP_CLIENT_ID', 'CI_GITHUB_ORG_APP_SLUG', ...orgSecrets]
  const values: Record<string, string> = {
    ...ciValues('gcp'),
    CI_GITHUB_ORG_APP_CLIENT_ID: 'org-client',
    CI_GITHUB_ORG_APP_SLUG: 'org-app',
    ...Object.fromEntries(
      orgSecrets.map((key, i) => [
        key,
        JSON.stringify({ address: `projects/test-project/secrets/org-${i}/versions/1` }),
      ]),
    ),
  }
  const declaration = groups([...ciKeys, ...orgKeys], [...ciSecrets, ...orgSecrets])
  const make = (input: Record<string, string>) =>
    apiEnvironmentFrom({
      environment: { ...base, ...input },
      declaration,
      home: 'gcp',
      region: 'us-east1',
      stage: 'dev',
    })
  const result = make(values)
  for (const key of orgSecrets) {
    assert.equal(result.environment[key], undefined)
    assert.ok(result.secrets[key])
  }
  assert.throws(() => make({ ...values, CI_GITHUB_ORG_APP_CLIENT_ID: values.CI_GITHUB_APP_CLIENT_ID }), /distinct/)
  assert.throws(
    () => make({ ...values, CI_GITHUB_ORG_WEBHOOK_SECRET: 'do-not-echo-secret' }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /CI_GITHUB_ORG_WEBHOOK_SECRET.*does not hold JSON/)
      assert.ok(!error.message.includes('do-not-echo-secret'))
      return true
    },
  )
  const declared = parseBase(
    new URL('../../mstage.env.json', import.meta.url).pathname,
    readFileSync(new URL('../../mstage.env.json', import.meta.url), 'utf8'),
  )
  for (const key of orgKeys) assert.ok(declared.envSelectGroup.api.includes(key))
  for (const key of orgSecrets) assert.ok(declared.envSelectGroup.secret.includes(key))
})

for (const [scenario, message] of [
  ['anchor', /Personal App identity is required/],
  ['client', /Organization App requires a distinct client ID/],
  ['slug', /Organization App slug is required/],
  ['private-key', /CI_GITHUB_ORG_APP_PRIVATE_KEY requires a mstage secret ref/],
  ['webhook', /CI_GITHUB_ORG_WEBHOOK_SECRET requires a mstage secret ref/],
  ['oauth-secret', /CI_GITHUB_OAUTH_CLIENT_SECRET requires a mstage secret ref/],
  ['oauth-anchor', /Identity OAuth requires the hosted CI storage anchor/],
  ['web-anchor', /CI_GITHUB_APP_CLIENT_ID is required for browser connect/],
] as const) {
  test(`optional CI App configuration fails closed for a missing or invalid ${scenario}`, () => {
    const ref = (name: string) => JSON.stringify({ address: `projects/test-project/secrets/${name}/versions/1` })
    const input: Record<string, string> = {
      ...ciValues('gcp'),
      CI_GITHUB_ORG_APP_CLIENT_ID: 'org-client',
      CI_GITHUB_ORG_APP_SLUG: 'org-app',
      CI_GITHUB_ORG_APP_PRIVATE_KEY: ref('org-key'),
      CI_GITHUB_ORG_WEBHOOK_SECRET: ref('org-hook'),
    }
    if (['anchor', 'oauth-anchor', 'web-anchor'].includes(scenario)) delete input.CI_GITHUB_APP_CLIENT_ID
    if (scenario === 'client') input.CI_GITHUB_ORG_APP_CLIENT_ID = 'org/invalid'
    if (scenario === 'slug') delete input.CI_GITHUB_ORG_APP_SLUG
    if (scenario === 'private-key') delete input.CI_GITHUB_ORG_APP_PRIVATE_KEY
    if (scenario === 'webhook') delete input.CI_GITHUB_ORG_WEBHOOK_SECRET
    if (scenario === 'oauth-secret') input.CI_GITHUB_OAUTH_CLIENT_ID = 'identity-client'
    if (scenario === 'oauth-anchor' || scenario === 'web-anchor') {
      for (const key of Object.keys(input)) if (key.startsWith('CI_GITHUB_ORG_')) delete input[key]
      if (scenario === 'oauth-anchor') {
        input.CI_GITHUB_OAUTH_CLIENT_ID = 'identity-client'
        input.CI_GITHUB_OAUTH_CLIENT_SECRET = ref('identity')
      } else input.CI_GITHUB_APP_CLIENT_SECRET = ref('personal-web')
    }
    const keys = Object.keys(input)
    const secrets = keys.filter((key) => input[key].startsWith('{'))
    assert.throws(
      () =>
        apiEnvironmentFrom({
          environment: { ...base, ...input },
          declaration: groups(keys, secrets),
          region: 'us-east1',
          stage: 'dev',
          home: 'gcp',
        }),
      message,
    )
  })
}

test('identity OAuth uses a distinct optional client and a secret reference without changing CI credentials', () => {
  const identity = 'CI_GITHUB_OAUTH_CLIENT_ID',
    secret = 'CI_GITHUB_OAUTH_CLIENT_SECRET'
  const declaration = groups([...ciKeys, identity, secret], [...ciSecrets, secret])
  const values = {
    ...base,
    ...ciValues('gcp'),
    [identity]: 'identity-client',
    [secret]: JSON.stringify({ address: 'projects/test-project/secrets/identity/versions/1' }),
  }
  const make = (environment: Record<string, string>) =>
    apiEnvironmentFrom({ environment, declaration, region: 'us-east1', stage: 'dev', home: 'gcp' })
  const result = make(values)
  assert.equal(result.environment[identity], 'identity-client')
  assert.equal(result.environment[secret], undefined)
  assert.equal(result.secrets[secret], 'projects/test-project/secrets/identity/versions/1')
  assert.equal(result.environment.CI_GITHUB_APP_CLIENT_ID, 'test-client')
  for (const invalid of [
    { ...values, [identity]: 'test-client' },
    { ...values, [identity]: '' },
  ])
    assert.throws(
      () => make(invalid),
      (error) => error instanceof ApiEnvironmentError && !error.message.includes('private-do-not-echo'),
    )
  for (const invalidSecret of ['', 'private-do-not-echo'])
    assert.throws(
      () => make({ ...values, [secret]: invalidSecret }),
      (error) => error instanceof EnvError && !error.message.includes('private-do-not-echo'),
    )
  const path = new URL('../../mstage.env.json', import.meta.url)
  const catalog = parseBase(path.pathname, readFileSync(path, 'utf8'))
  assert.ok(catalog.envOptional.api.includes(identity))
  assert.ok(catalog.envOptional.api.includes(secret))
  assert.ok(catalog.envSelectGroup.secret.includes(secret))
  assert.equal(catalog.envSelectGroup.secret.includes(identity), false)
})
