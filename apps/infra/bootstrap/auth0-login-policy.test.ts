// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import {
  Auth0CliManagementClient,
  Auth0LoginPolicyConfigurator,
  assertDatabaseConnectionCompatible,
  assertEmailDeliveryReady,
  assertJournalSnapshotSafe,
  buildDatabaseConnectionUpdate,
  buildLoginPolicyBindings,
  buildPromptUpdate,
  emailDeliveryReadiness,
  hydrateEmailVerificationTemplate,
  hydrateLoginPolicyAction,
  parseAuth0LoginPolicyOptions,
} from './auth0-login-policy.js'
import type { Auth0ManagementClient } from './auth0-login-policy.js'

test('buildDatabaseConnectionUpdate configures verification OTP without adding an OTP login method', () => {
  const connection = {
    id: 'con_123',
    name: 'boxlite-users',
    strategy: 'auth0',
    enabled_clients: ['spa_123', 'other_client'],
    options: {
      brute_force_protection: true,
      passwordPolicy: 'good',
      password_history: { enable: true, size: 5 },
      authentication_methods: { passkey: { enabled: false } },
    },
  }

  const update = buildDatabaseConnectionUpdate(connection)

  assert.equal(update.enabled_clients, undefined)
  assert.equal(update.options.brute_force_protection, true)
  assert.deepEqual(update.options.password_history, { enable: true, size: 5 })
  assert.deepEqual(update.options.authentication_methods, {
    passkey: { enabled: false },
    password: { enabled: true, signup_behavior: 'allow' },
  })
  assert.deepEqual(update.options.attributes, {
    email: {
      identifier: { active: true, default_method: 'password' },
      profile_required: true,
      signup: { status: 'required', verification: { active: true } },
      unique: true,
      verification_method: 'otp',
    },
  })
  assert.deepEqual(connection.options.authentication_methods, { passkey: { enabled: false } })
})

test('buildDatabaseConnectionUpdate deep-merges inactive attributes and email settings', () => {
  const update = buildDatabaseConnectionUpdate({
    enabled_clients: ['spa_123'],
    options: {
      disable_signup: true,
      disable_self_service_change_password: true,
      authentication_methods: {
        password: { enabled: false, signup_behavior: 'block' },
        email_otp: { enabled: false, custom_setting: 'keep' },
      },
      attributes: {
        username: { identifier: { active: false }, signup: { status: 'off' } },
        email: { identifier: { upstream_setting: 'keep' }, custom_setting: 'keep' },
      },
    },
  })

  assert.deepEqual(update.options.attributes.username, {
    identifier: { active: false },
    signup: { status: 'off' },
  })
  assert.equal(update.options.attributes.email.custom_setting, 'keep')
  assert.equal(update.options.attributes.email.identifier.upstream_setting, 'keep')
  assert.equal(update.options.attributes.email.identifier.default_method, 'password')
  assert.equal(update.options.disable_signup, false)
  assert.equal(update.options.disable_self_service_change_password, false)
  assert.deepEqual(update.options.authentication_methods.password, {
    enabled: true,
    signup_behavior: 'allow',
  })
  assert.deepEqual(update.options.authentication_methods.email_otp, {
    enabled: false,
    custom_setting: 'keep',
  })
})

test('assertDatabaseConnectionCompatible rejects configurations that cannot safely migrate', () => {
  const base = { id: 'con_123', name: 'boxlite-users', strategy: 'auth0', options: {} }
  const activatedBase = {
    ...base,
    options: { attributes: { email: { identifier: { active: true } } } },
  }

  assert.throws(
    () => assertDatabaseConnectionCompatible({ ...base, strategy: 'google-oauth2' }, []),
    /must use the auth0 database strategy/,
  )
  assert.throws(
    () => assertDatabaseConnectionCompatible({ ...base, options: { customScripts: { login: 'return cb()' } } }, []),
    /custom database/,
  )
  assert.throws(
    () => assertDatabaseConnectionCompatible(base, []),
    /activate Auth0's New Attributes Configuration/,
  )
  assert.throws(
    () =>
      assertDatabaseConnectionCompatible(
        { ...base, options: { attributes: { username: { identifier: { active: true } } } } },
        [],
      ),
    /username identifier/,
  )
  assert.throws(
    () => assertDatabaseConnectionCompatible(activatedBase, [{ user_id: 'auth0|missing-email' }]),
    /has no email/,
  )
  assert.throws(
    () =>
      assertDatabaseConnectionCompatible(
        {
          ...base,
          options: { authentication_methods: { password: { enabled: true }, passkey: { enabled: true } } },
        },
        [],
      ),
    /passkey authentication/,
  )
})

test('Auth0 login policy login requests connection-options scopes', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const loginCommand = packageJson.scripts['auth0:login-policy-login']

  assert.match(loginCommand, /read:connections_options/)
  assert.match(loginCommand, /update:connections_options/)
  assert.match(loginCommand, /read:client_credentials/)
})

test('rollback snapshots reject credential fields and credential-like string values before writing', () => {
  assert.throws(
    () => assertJournalSnapshotSafe('form', { config: { api_key: 'should-not-be-stored' } }),
    /credential-like field/,
  )
  assert.throws(
    () => assertJournalSnapshotSafe('prompt', { custom_text: 'Bearer abcdefghijklmnop' }),
    /credential-like value/,
  )
  for (const snapshot of [
    { password: 'hidden' },
    { token: 'hidden' },
    { clientSecret: 'hidden' },
    { smtp_password: 'hidden' },
    { 'api-key': 'hidden' },
  ]) {
    assert.throws(() => assertJournalSnapshotSafe('form', snapshot), /credential-like field/)
  }
  assert.doesNotThrow(() =>
    assertJournalSnapshotSafe('connection', {
      options: { passwordPolicy: 'good', authentication_methods: { password: { enabled: true } } },
    }),
  )
})

test('buildPromptUpdate enables New Universal Login Identifier First without replacing other prompt settings', () => {
  assert.deepEqual(buildPromptUpdate({ webauthn_platform_first_factor: false, custom: 'keep' }), {
    webauthn_platform_first_factor: false,
    custom: 'keep',
    universal_login_experience: 'new',
    identifier_first: true,
  })
})

test('buildLoginPolicyBindings replaces the legacy claims Action and preserves unrelated Actions', () => {
  assert.deepEqual(
    buildLoginPolicyBindings('act_login_policy', [
      { action: { id: 'act_legacy' }, display_name: 'boxlite-custom-claims' },
      { action: { id: 'act_unrelated' }, display_name: 'organization-enrichment' },
    ]),
    [
      { ref: { type: 'action_id', value: 'act_unrelated' }, display_name: 'organization-enrichment' },
      { ref: { type: 'action_id', value: 'act_login_policy' }, display_name: 'boxlite-login-policy' },
    ],
  )
})

test('a disabled custom email provider never falls back to Auth0 built-in delivery', () => {
  const readiness = emailDeliveryReadiness({ name: 'ses', enabled: false }, null, null, true)

  assert.equal(readiness.externalEmailProvider, false)
  assert.equal(readiness.auth0BuiltInEmailProvider, false)
  assert.equal(readiness.readyToApply, false)
  assert.throws(() => assertEmailDeliveryReady(readiness), /enabled external Auth0 email provider is required/)
})

test('hydrateEmailVerificationTemplate wires exact resource ids and leaves no placeholders', () => {
  const template = {
    form: { name: 'BoxLite verify email', nodes: [{ flow_id: '#FLOW-1#' }, { flow_id: '#FLOW-2#' }] },
    flows: [
      { name: 'Generate OTP', actions: [{ connection_id: '#CONN-1#', length: 6 }] },
      { name: 'Verify OTP', actions: [{ connection_id: '#CONN-1#', email_verified: true }] },
    ],
  }

  const hydrated = hydrateEmailVerificationTemplate(template, {
    generateFlowId: 'fl_generate',
    verifyFlowId: 'fl_verify',
    vaultConnectionId: 'ac_auth0',
  })

  assert.equal(JSON.stringify(hydrated).includes('#FLOW-'), false)
  assert.equal(JSON.stringify(hydrated).includes('#CONN-'), false)
  assert.match(JSON.stringify(hydrated), /fl_generate/)
  assert.match(JSON.stringify(hydrated), /fl_verify/)
  assert.match(JSON.stringify(hydrated), /ac_auth0/)
})

test('hydrateLoginPolicyAction embeds exact non-secret resource identifiers safely', () => {
  const hydrated = hydrateLoginPolicyAction(
    'const client = __BOXLITE_CLIENT_ID_JSON__; const connection = __BOXLITE_DB_CONNECTION_JSON__; const form = __EMAIL_VERIFICATION_FORM_ID_JSON__;',
    { clientId: 'spa_"quoted', connectionName: 'boxlite-users', formId: 'ap_verify' },
  )

  assert.match(hydrated, /"spa_\\"quoted"/)
  assert.equal(hydrated.includes('__BOXLITE_'), false)
  assert.equal(hydrated.includes('__EMAIL_VERIFICATION_'), false)
})

test('parseAuth0LoginPolicyOptions defaults to preview and requires exact tenant, client, and connection', () => {
  assert.deepEqual(
    parseAuth0LoginPolicyOptions([
      '--tenant',
      'tenant.us.auth0.com',
      '--client-id',
      'spa_123',
      '--connection',
      'boxlite-users',
    ]),
    {
      tenant: 'tenant.us.auth0.com',
      clientId: 'spa_123',
      connectionName: 'boxlite-users',
      apply: false,
      allowTestEmailProvider: false,
    },
  )
  assert.throws(() => parseAuth0LoginPolicyOptions(['--tenant', 'tenant.us.auth0.com']), /--client-id is required/)
})

test('Auth0CliManagementClient sends sensitive bodies over stdin, never process argv', () => {
  let capturedArgs: string[] = []
  let capturedInput = ''
  const client = new Auth0CliManagementClient('tenant.us.auth0.com', (_command, args, options) => {
    capturedArgs = args
    capturedInput = options.input ?? ''
    return '{}'
  })

  client.request('post', 'flows/vault/connections', {
    data: { setup: { client_secret: 'must-not-appear-on-argv' } },
  })

  assert.equal(capturedArgs.join(' ').includes('must-not-appear-on-argv'), false)
  assert.equal(capturedArgs.includes('--data'), false)
  assert.match(capturedInput, /must-not-appear-on-argv/)
})

test('Auth0CliManagementClient encodes Auth0 search expressions but preserves comma-delimited fields', () => {
  let capturedArgs: string[] = []
  const client = new Auth0CliManagementClient('tenant.us.auth0.com', (_command, args) => {
    capturedArgs = args
    return '{"users":[],"total":0}'
  })

  client.request('get', 'users', {
    query: {
      q: 'identities.connection:"Username-Password-Authentication"',
      search_engine: 'v3',
      fields: 'name,enabled,credentials',
    },
  })

  const queryArguments = capturedArgs.filter((_argument, index) => capturedArgs[index - 1] === '--query')
  assert.ok(queryArguments.includes('q=identities.connection%3A%22Username-Password-Authentication%22'))
  assert.ok(queryArguments.includes('search_engine=v3'))
  assert.ok(queryArguments.includes('fields=name,enabled,credentials'))
})

test('Auth0CliManagementClient retains API error metadata without exposing the response in its message', () => {
  const cliFailure: any = new Error('auth0 CLI failed')
  cliFailure.status = 1
  cliFailure.stderr = Buffer.from(`
=== tenant.us.auth0.com error

 ▸    400: API request failed: {"statusCode":400,"error":"Bad Request","message":"Email verification using otp is only compatible with Identifier First.","errorCode":"invalid_body"}.
`)
  const client = new Auth0CliManagementClient('tenant.us.auth0.com', () => {
    throw cliFailure
  })

  let failure: any
  try {
    client.request('patch', 'connections/con_123', { data: { options: {} } })
    assert.fail('request should propagate the Auth0 API failure')
  } catch (error) {
    failure = error
  }

  assert.equal(failure.statusCode, 400)
  assert.equal(failure.errorCode, 'invalid_body')
  assert.equal(failure.apiMessage, 'Email verification using otp is only compatible with Identifier First.')
  assert.equal(failure.message.includes(failure.apiMessage), false)
})

test('Auth0LoginPolicyConfigurator preview is read-only and reports prerequisites/resources', () => {
  const calls: Array<{ method: string; path: string; page?: string }> = []
  let usesBuiltInEmailProvider = false
  const client: Auth0ManagementClient = {
    request(method, path, options = {}) {
      calls.push({ method, path, page: options.query?.page })
      if (path === 'actions/actions' && options.query?.include_totals) {
        throw new Error("Query validation error: 'Additional properties not allowed: include_totals'")
      }
      if (path === 'connections') {
        if (options.query?.page === '0') {
          return {
            connections: Array.from({ length: 100 }, (_value, index) => ({
              id: `con_filler_${index}`,
              name: `filler-${index}`,
              strategy: 'google-oauth2',
            })),
            total: 101,
          }
        }
        return {
          connections: [
            {
              id: 'con_123',
              name: 'boxlite-users',
              strategy: 'auth0',
              enabled_clients: ['spa_123'],
              options: { attributes: { email: { identifier: { active: true } } } },
            },
          ],
          total: 101,
        }
      }
      if (usesBuiltInEmailProvider && (path === 'emails/provider' || path.startsWith('email-templates/'))) {
        return null
      }
      const responses: Record<string, any> = {
        'clients/spa_123': { client_id: 'spa_123', name: 'boxlite-dashboard', app_type: 'spa' },
        'clients/spa_123/connections': {
          connections: [{ id: 'con_123', name: 'boxlite-users', strategy: 'auth0' }],
        },
        'connections/con_123': {
          id: 'con_123',
          name: 'boxlite-users',
          strategy: 'auth0',
          enabled_clients: ['spa_123'],
          options: { attributes: { email: { identifier: { active: true } } } },
        },
        users: { users: [{ user_id: 'auth0|123', email: 'person@example.com' }], total: 1 },
        'emails/provider': { name: 'smtp', enabled: true },
        'email-templates/verify_email_by_code': { template: 'verify_email_by_code', enabled: true },
        'email-templates/reset_email_by_code': { template: 'reset_email_by_code', enabled: true },
        prompts: { universal_login_experience: 'classic', identifier_first: false },
        clients: [{ client_id: 'spa_123', name: 'boxlite-dashboard', app_type: 'spa' }],
        'client-grants': [],
        'flows/vault/connections': [],
        flows: [],
        forms: [],
        'actions/actions': [],
        'actions/triggers/post-login/bindings': { bindings: [] },
      }
      return responses[path]
    },
  }
  const configurator = new Auth0LoginPolicyConfigurator(
    {
      tenant: 'tenant.us.auth0.com',
      clientId: 'spa_123',
      connectionName: 'boxlite-users',
      apply: false,
      allowTestEmailProvider: false,
    },
    client,
    {
      actionCode: 'exports.onExecutePostLogin = async () => {}',
      emailVerificationTemplate: {},
      journalDirectory: '/unused',
    },
  )

  const preview = configurator.preview()

  assert.equal(preview.readyToApply, true)
  assert.equal(preview.connection.usersChecked, 1)
  assert.deepEqual(preview.resources.action, { change: 'create', id: null })
  assert.equal(
    calls.some((call) => call.path === 'connections' && call.page === '1'),
    true,
  )
  assert.equal(
    calls.every((call) => call.method === 'get'),
    true,
  )

  usesBuiltInEmailProvider = true
  const builtInPreview = new Auth0LoginPolicyConfigurator(
    {
      tenant: 'tenant.us.auth0.com',
      clientId: 'spa_123',
      connectionName: 'boxlite-users',
      apply: false,
      allowTestEmailProvider: true,
    },
    client,
    {
      actionCode: 'exports.onExecutePostLogin = async () => {}',
      emailVerificationTemplate: {},
      journalDirectory: '/unused',
    },
  ).preview()

  assert.equal(builtInPreview.prerequisites.externalEmailProvider, false)
  assert.equal(builtInPreview.prerequisites.auth0BuiltInEmailProvider, true)
  assert.equal(builtInPreview.readyToApply, true)
})

test('new client grants use explicit scopes without the mutually exclusive allow-all field', () => {
  const journalDirectory = mkdtempSync(join(tmpdir(), 'boxlite-auth0-policy-grant-'))
  let grantPayload: Record<string, any> | undefined
  const connection = {
    id: 'con_123',
    name: 'boxlite-users',
    strategy: 'auth0',
    enabled_clients: ['spa_123'],
    options: { attributes: { email: { identifier: { active: true } } } },
  }
  const client: Auth0ManagementClient = {
    request(method, path, options = {}) {
      if (method === 'post' && path === 'clients') {
        return {
          ...options.data,
          client_id: 'm2m_123',
          client_secret: 'vault-setup-only',
        }
      }
      if (method === 'post' && path === 'client-grants') {
        grantPayload = options.data
        if (grantPayload && 'allow_all_scopes' in grantPayload) {
          throw new Error('Auth0 rejected mutually exclusive client-grant fields')
        }
        throw new Error('client-grant payload accepted sentinel')
      }
      const responses: Record<string, any> = {
        'clients/spa_123': { client_id: 'spa_123', name: 'boxlite-dashboard', app_type: 'spa' },
        'clients/spa_123/connections': { connections: [connection] },
        connections: [connection],
        'connections/con_123': connection,
        users: { users: [], total: 0 },
        'emails/provider': null,
        'email-templates/verify_email_by_code': null,
        'email-templates/reset_email_by_code': null,
        prompts: { universal_login_experience: 'new', identifier_first: false },
        clients: [{ client_id: 'spa_123', name: 'boxlite-dashboard', app_type: 'spa' }],
        'client-grants': [],
        'flows/vault/connections': [],
        flows: [],
        forms: [],
        'actions/actions': [],
        'actions/triggers/post-login/bindings': { bindings: [] },
      }
      return responses[path]
    },
  }

  try {
    const configurator = new Auth0LoginPolicyConfigurator(
      {
        tenant: 'tenant.us.auth0.com',
        clientId: 'spa_123',
        connectionName: 'boxlite-users',
        apply: true,
        allowTestEmailProvider: true,
      },
      client,
      {
        actionCode: 'exports.onExecutePostLogin = async () => {}',
        emailVerificationTemplate: {},
        journalDirectory,
      },
    )

    let failure: any
    try {
      configurator.apply()
      assert.fail('apply should stop at the client-grant sentinel')
    } catch (error) {
      failure = error
    }
    assert.match(failure.cause?.message ?? '', /client-grant payload accepted sentinel/)
    assert.deepEqual(grantPayload, {
      client_id: 'm2m_123',
      audience: 'https://tenant.us.auth0.com/api/v2/',
      scope: ['update:users'],
    })
  } finally {
    rmSync(journalDirectory, { recursive: true, force: true })
  }
})

test('database connection setup retries Identifier First propagation without adding OTP login', () => {
  const journalDirectory = mkdtempSync(join(tmpdir(), 'boxlite-auth0-policy-connection-'))
  let isIdentifierFirst = false
  let propagationFailures = 1
  let connectionPayload: Record<string, any> | undefined
  const calls: Array<{ method: string; path: string }> = []
  const client: Auth0ManagementClient = {
    request(method, path, options = {}) {
      calls.push({ method, path })
      if (method === 'patch' && path === 'prompts') {
        isIdentifierFirst = !Array.isArray(options.data) && options.data?.identifier_first === true
        return {}
      }
      if (method === 'post' && path === 'connections') {
        if (!isIdentifierFirst || propagationFailures-- > 0) {
          throw new Error('Email verification using otp is only compatible with Identifier First.')
        }
        connectionPayload = Array.isArray(options.data) ? undefined : options.data
        return { id: 'con_123', ...connectionPayload }
      }
      if (method === 'post' && path === 'clients') throw new Error('management client sentinel')
      const responses: Record<string, any> = {
        'clients/spa_123': { client_id: 'spa_123', name: 'boxlite-dashboard', app_type: 'spa' },
        'clients/spa_123/connections': { connections: [] },
        connections: [],
        'emails/provider': null,
        'email-templates/verify_email_by_code': null,
        'email-templates/reset_email_by_code': null,
        prompts: { universal_login_experience: 'classic', identifier_first: false },
        clients: [{ client_id: 'spa_123', name: 'boxlite-dashboard', app_type: 'spa' }],
        'client-grants': [],
        'flows/vault/connections': [],
        flows: [],
        forms: [],
        'actions/actions': [],
        'actions/triggers/post-login/bindings': { bindings: [] },
      }
      return responses[path]
    },
  }

  try {
    const configurator = new Auth0LoginPolicyConfigurator(
      {
        tenant: 'tenant.us.auth0.com',
        clientId: 'spa_123',
        connectionName: 'boxlite-users',
        apply: true,
        allowTestEmailProvider: true,
      },
      client,
      {
        actionCode: 'exports.onExecutePostLogin = async () => {}',
        emailVerificationTemplate: {},
        journalDirectory,
      },
    )

    let failure: any
    try {
      configurator.apply()
      assert.fail('apply should stop at the management client sentinel')
    } catch (error) {
      failure = error
    }
    assert.match(failure.cause?.message ?? '', /management client sentinel/)
    assert.equal(connectionPayload?.options.attributes.email.verification_method, 'otp')
    assert.equal(connectionPayload?.options.authentication_methods.email_otp, undefined)
    assert.deepEqual(
      calls
        .filter((call) =>
          (call.method === 'patch' && call.path === 'prompts') ||
          (call.method === 'post' && call.path === 'connections'),
        )
        .map((call) => `${call.method} ${call.path}`),
      ['patch prompts', 'post connections', 'post connections'],
    )
  } finally {
    rmSync(journalDirectory, { recursive: true, force: true })
  }
})

test('Auth0LoginPolicyConfigurator applies, binds last, reads back, and journals without credentials', () => {
  const journalDirectory = mkdtempSync(join(tmpdir(), 'boxlite-auth0-policy-'))
  const template = JSON.parse(readFileSync(new URL('./auth0/email-verification-form.json', import.meta.url), 'utf8'))
  const calls: Array<{ method: string; path: string; data?: Record<string, any> }> = []
  let propagationFailures = 1
  const state: Record<string, any> = {
    client: { client_id: 'spa_123', name: 'boxlite-dashboard', app_type: 'spa' },
    connection: {
      id: 'con_123',
      name: 'boxlite-users',
      strategy: 'auth0',
      enabled_clients: ['spa_123'],
      options: {
        passwordPolicy: 'good',
        attributes: { email: { identifier: { active: true } } },
      },
    },
    clientConnectionEnabled: false,
    prompt: { universal_login_experience: 'new' },
    managementClient: {
      client_id: 'm2m_123',
      name: 'boxlite-forms-email-verification',
      app_type: 'non_interactive',
      token_endpoint_auth_method: 'client_secret_post',
      client_metadata: { boxlite_login_policy: 'email-verification-v1' },
    },
    grant: {
      id: 'cgr_123',
      client_id: 'm2m_123',
      audience: 'https://tenant.us.auth0.com/api/v2/',
      scope: ['update:users', 'delete:users'],
      allow_all_scopes: true,
    },
    vault: { id: 'ac_123', name: 'BoxLite Forms Auth0 Management API', app_id: 'AUTH0', ready: true },
    flows: [
      { id: 'fl_generate', name: 'BoxLite generate email OTP', actions: [] },
      { id: 'fl_verify', name: 'BoxLite verify email OTP', actions: [] },
    ],
    form: {
      id: 'ap_verify',
      name: 'BoxLite email verification',
      languages: { primary: 'en' },
      nodes: [],
      start: {},
      ending: {},
    },
    action: null,
    bindings: [{ action: { id: 'act_legacy' }, display_name: 'boxlite-custom-claims' }],
  }
  state.flows = [
    {
      id: 'fl_generate',
      ...JSON.parse(JSON.stringify(template.flows['#FLOW-1#']).replaceAll('#CONN-1#', 'ac_123')),
    },
    {
      id: 'fl_verify',
      ...JSON.parse(JSON.stringify(template.flows['#FLOW-2#']).replaceAll('#CONN-1#', 'ac_123')),
    },
  ]
  state.form = {
    id: 'ap_verify',
    ...hydrateEmailVerificationTemplate(template, {
      generateFlowId: 'fl_generate',
      verifyFlowId: 'fl_verify',
      vaultConnectionId: 'ac_123',
    }).form,
  }
  writeFileSync(
    join(journalDirectory, 'owned-auth0-login-policy.json'),
    JSON.stringify({
      version: 1,
      tenant: 'tenant.us.auth0.com',
      clientId: 'spa_123',
      connectionName: 'boxlite-users',
      createdAt: '2026-08-25T00:00:00.000Z',
      entries: [{ kind: 'vault connection', path: 'flows/vault/connections', id: 'ac_123', created: true }],
    }),
  )
  const client: Auth0ManagementClient = {
    request(method, path, options = {}) {
      calls.push({ method, path, data: options.data })
      if (path === 'clients/spa_123/connections' && options.query?.take !== '100') {
        throw new Error(`invalid client-connection page size ${options.query?.take}`)
      }
      if (method === 'get') {
        const reads: Record<string, any> = {
          'clients/spa_123': state.client,
          'clients/m2m_123': { ...state.managementClient, client_secret: 'vault-setup-only' },
          'clients/spa_123/connections': {
            connections: state.clientConnectionEnabled ? [state.connection] : [],
          },
          connections: [state.connection],
          'connections/con_123': state.connection,
          users: { users: [{ user_id: 'auth0|123', email: 'person@example.com' }], total: 1 },
          'emails/provider': { name: 'smtp', enabled: true },
          'email-templates/verify_email_by_code': { enabled: true },
          'email-templates/reset_email_by_code': { enabled: true },
          prompts: state.prompt,
          clients: [state.client, state.managementClient],
          'client-grants': [state.grant],
          'flows/vault/connections': [state.vault],
          'flows/vault/connections/ac_123': state.vault,
          flows: state.flows,
          'flows/fl_generate': state.flows[0],
          'flows/fl_verify': state.flows[1],
          forms: [state.form],
          'forms/ap_verify': state.form,
          'actions/actions': state.action ? [state.action] : [],
          'actions/actions/act_policy': state.action,
          'actions/triggers/post-login/bindings': { bindings: state.bindings },
        }
        return reads[path]
      }
      if (method === 'patch' && path === 'connections/con_123') {
        if (state.prompt.identifier_first !== true || propagationFailures-- > 0) {
          throw new Error('Email verification using otp is only compatible with Identifier First.')
        }
        Object.assign(state.connection, options.data)
      }
      if (method === 'patch' && path === 'connections/con_123/clients') {
        const update = options.data?.find((candidate: any) => candidate.client_id === 'spa_123')
        state.clientConnectionEnabled = update?.status === true
      }
      if (method === 'patch' && path === 'prompts') state.prompt = { ...state.prompt, ...options.data }
      if (method === 'patch' && path === 'client-grants/cgr_123') Object.assign(state.grant, options.data)
      if (method === 'patch' && path.startsWith('flows/')) {
        const flow = state.flows.find((candidate: any) => candidate.id === path.split('/')[1])
        Object.assign(flow, options.data)
        return flow
      }
      if (method === 'patch' && path === 'forms/ap_verify') {
        Object.assign(state.form, options.data)
        return state.form
      }
      if (method === 'post' && path === 'actions/actions') {
        state.action = {
          id: 'act_policy',
          ...options.data,
          secrets: [],
          all_changes_deployed: false,
        }
        return state.action
      }
      if (method === 'patch' && path === 'actions/actions/act_policy') {
        Object.assign(state.action, options.data)
        return state.action
      }
      if (method === 'post' && path === 'actions/actions/act_policy/deploy') {
        state.action.all_changes_deployed = true
        state.action.deployed_version = {
          code: state.action.code,
          runtime: state.action.runtime,
          deployed: true,
          secrets: [],
        }
        return {}
      }
      if (method === 'patch' && path === 'actions/triggers/post-login/bindings') {
        const bindings = Array.isArray(options.data) ? [] : (options.data?.bindings ?? [])
        state.bindings = bindings.map((binding: any) => ({
          action: { id: binding.ref.value },
          display_name: binding.display_name,
        }))
      }
      return {}
    },
  }

  try {
    const configurator = new Auth0LoginPolicyConfigurator(
      {
        tenant: 'tenant.us.auth0.com',
        clientId: 'spa_123',
        connectionName: 'boxlite-users',
        apply: true,
        allowTestEmailProvider: false,
      },
      client,
      {
        actionCode: 'exports.onExecutePostLogin = async () => {}',
        emailVerificationTemplate: template,
        journalDirectory,
      },
    )

    const result = configurator.apply()
    const bindingCall = calls.findIndex(
      (call) => call.path === 'actions/triggers/post-login/bindings' && call.method === 'patch',
    )
    const promptCall = calls.findIndex((call) => call.path === 'prompts' && call.method === 'patch')
    const connectionCall = calls.findIndex(
      (call) => call.path === 'connections/con_123' && call.method === 'patch',
    )
    const grantCall = calls.findIndex(
      (call) => call.path === 'client-grants/cgr_123' && call.method === 'patch',
    )
    const connectionBindingCall = calls.find(
      (call) => call.path === 'connections/con_123/clients' && call.method === 'patch',
    )
    const deployCall = calls.findIndex((call) => call.path === 'actions/actions/act_policy/deploy')
    const journalPath = result.journal as string
    const journal = readFileSync(journalPath, 'utf8')

    assert.equal(result.mode, 'applied')
    assert.equal(state.connection.options.passwordPolicy, 'good')
    assert.equal(state.connection.options.attributes.email.identifier.default_method, 'password')
    assert.deepEqual(state.grant.scope, ['update:users'])
    assert.equal(state.grant.allow_all_scopes, false)
    assert.deepEqual(connectionBindingCall?.data, [{ client_id: 'spa_123', status: true }])
    assert.equal(state.clientConnectionEnabled, true)
    assert.equal(state.prompt.identifier_first, true)
    assert.equal(promptCall < connectionCall, true)
    assert.equal(connectionCall < grantCall, true)
    assert.equal(
      state.bindings.some((binding: any) => binding.action.id === 'act_policy'),
      true,
    )
    assert.equal(bindingCall > deployCall, true)
    assert.equal(journal.includes('client_secret'), false)
    assert.equal(journal.includes('"kind": "flow"'), false)
    assert.equal(journal.includes('"kind": "verification form"'), false)
    assert.match(journal, /passwordPolicy/)

    const reapplyStart = calls.length
    const reapplied = configurator.apply()
    const reapplyPrerequisiteWrites = calls.slice(reapplyStart).filter(
      (call) =>
        call.method === 'patch' &&
        (call.path === 'prompts' || call.path === 'connections/con_123'),
    )

    assert.equal(reapplied.mode, 'applied')
    assert.deepEqual(reapplyPrerequisiteWrites, [])

    const rollback = Auth0LoginPolicyConfigurator.rollback(journalPath, () => client)

    assert.equal(rollback.mode, 'rolled-back')
    assert.equal(state.clientConnectionEnabled, false)
    assert.equal(state.prompt.identifier_first, false)
    assert.deepEqual(state.grant.scope, ['update:users', 'delete:users'])
    assert.equal(state.grant.allow_all_scopes, true)
  } finally {
    rmSync(journalDirectory, { recursive: true, force: true })
  }
})

type ActionHandler = (event: any, api: any) => Promise<void>

function loadAction(): { onExecutePostLogin: ActionHandler; onContinuePostLogin: ActionHandler } {
  const source = hydrateLoginPolicyAction(readFileSync(new URL('./auth0/login-policy.js', import.meta.url), 'utf8'), {
    clientId: 'spa_123',
    connectionName: 'boxlite-users',
    formId: 'ap_verify',
  })
  const exports: Record<string, ActionHandler> = {}
  runInNewContext(source, { exports })
  return exports as { onExecutePostLogin: ActionHandler; onContinuePostLogin: ActionHandler }
}

function managedEvent(overrides: Record<string, any> = {}) {
  return {
    authorization: {},
    client: { client_id: 'spa_123' },
    connection: { name: 'boxlite-users', strategy: 'auth0' },
    secrets: {
      BOXLITE_CLIENT_ID: 'spa_123',
      BOXLITE_DB_CONNECTION: 'boxlite-users',
      EMAIL_VERIFICATION_FORM_ID: 'ap_verify',
    },
    transaction: { protocol: 'oidc-basic-profile' },
    user: { user_id: 'auth0|123', email: 'person@example.com', email_verified: false, name: 'Person' },
    ...overrides,
  }
}

function actionApi() {
  const claims: Record<string, unknown> = {}
  const rendered: string[] = []
  const denied: string[] = []
  return {
    claims,
    rendered,
    denied,
    api: {
      access: { deny: (reason: string) => denied.push(reason) },
      accessToken: { setCustomClaim: (name: string, value: unknown) => (claims[name] = value) },
      prompt: { render: (id: string) => rendered.push(id) },
    },
  }
}

test('login policy copies claims for verified managed database users', async () => {
  const { onExecutePostLogin } = loadAction()
  const capture = actionApi()

  await onExecutePostLogin(managedEvent({ user: { ...managedEvent().user, email_verified: true } }), capture.api)

  assert.deepEqual(capture.rendered, [])
  assert.deepEqual(capture.denied, [])
  assert.equal(capture.claims.email_verified, true)
  assert.equal(capture.claims.email, 'person@example.com')
})

test('login policy renders the exact verification form only for browser login', async () => {
  const { onExecutePostLogin } = loadAction()
  const capture = actionApi()

  await onExecutePostLogin(managedEvent(), capture.api)

  assert.deepEqual(capture.rendered, ['ap_verify'])
  assert.deepEqual(capture.denied, [])
  assert.deepEqual(capture.claims, {})
})

for (const protocol of ['oauth2-refresh-token', 'oauth2-device-code', 'oauth2-resource-owner']) {
  test(`login policy denies an unverified ${protocol} transaction`, async () => {
    const { onExecutePostLogin } = loadAction()
    const capture = actionApi()

    await onExecutePostLogin(managedEvent({ transaction: { protocol } }), capture.api)

    assert.deepEqual(capture.rendered, [])
    assert.match(capture.denied[0], /Email verification required/)
  })
}

test('login policy leaves social identities and other clients outside the verification gate', async () => {
  const { onExecutePostLogin } = loadAction()
  const social = actionApi()
  const otherClient = actionApi()

  await onExecutePostLogin(
    managedEvent({ connection: { name: 'google-oauth2', strategy: 'google-oauth2' } }),
    social.api,
  )
  await onExecutePostLogin(managedEvent({ client: { client_id: 'other_spa' } }), otherClient.api)

  assert.deepEqual(social.denied, [])
  assert.deepEqual(otherClient.denied, [])
  assert.equal(social.claims.email_verified, false)
  assert.equal(otherClient.claims.email_verified, false)
})

test('login policy continuation trusts only the exact verification form', async () => {
  const { onContinuePostLogin } = loadAction()
  const success = actionApi()
  const wrongForm = actionApi()

  await onContinuePostLogin(managedEvent({ prompt: { id: 'ap_verify', fields: {} } }), success.api)
  await onContinuePostLogin(managedEvent({ prompt: { id: 'ap_other', fields: {} } }), wrongForm.api)

  assert.equal(success.claims.email_verified, true)
  assert.match(wrongForm.denied[0], /Email verification failed/)
  assert.deepEqual(wrongForm.claims, {})
})
