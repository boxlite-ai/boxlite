// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

type JsonObject = Record<string, any>
type JsonBody = JsonObject | JsonObject[]
type HttpMethod = 'get' | 'post' | 'patch' | 'delete'

const RESOURCE_NAMES = {
  action: 'boxlite-login-policy',
  form: 'BoxLite email verification',
  generateFlow: 'BoxLite generate email OTP',
  verifyFlow: 'BoxLite verify email OTP',
  managementClient: 'boxlite-forms-email-verification',
  vaultConnection: 'BoxLite Forms Auth0 Management API',
} as const
const LEGACY_ACTION_NAME = 'boxlite-custom-claims'

const MANAGEMENT_AUDIENCE_SUFFIX = '/api/v2/'
const MANAGEMENT_CLIENT_SCOPES = ['update:users']
const MANAGEMENT_CLIENT_METADATA = { boxlite_login_policy: 'email-verification-v1' }
const IDENTIFIER_FIRST_PROPAGATION_ERROR = 'Email verification using otp is only compatible with Identifier First.'
const DATABASE_CONNECTION_WRITE_ATTEMPTS = 4
const LOGIN_POLICY_MANAGEMENT_SCOPES = [
  'read:clients',
  'read:client_credentials',
  'create:clients',
  'delete:clients',
  'read:client_grants',
  'create:client_grants',
  'update:client_grants',
  'delete:client_grants',
  'read:connections',
  'create:connections',
  'update:connections',
  'delete:connections',
  'read:connections_options',
  'update:connections_options',
  'read:users',
  'read:email_provider',
  'create:email_provider',
  'delete:email_provider',
  'read:email_templates',
  'create:email_templates',
  'update:email_templates',
  'read:prompts',
  'update:prompts',
  'read:actions',
  'create:actions',
  'update:actions',
  'delete:actions',
  'read:forms',
  'create:forms',
  'update:forms',
  'delete:forms',
  'read:flows',
  'create:flows',
  'update:flows',
  'delete:flows',
  'read:flows_vault_connections',
  'create:flows_vault_connections',
  'update:flows_vault_connections',
  'delete:flows_vault_connections',
]

export interface Auth0LoginPolicyOptions {
  tenant: string
  clientId: string
  connectionName: string
  apply: boolean
  allowTestEmailProvider: boolean
}

export function parseAuth0LoginPolicyOptions(argv: string[]): Auth0LoginPolicyOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      tenant: { type: 'string' },
      'client-id': { type: 'string' },
      connection: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'allow-test-email-provider': { type: 'boolean', default: false },
    },
  })

  const tenant = requireExactValue('--tenant', values.tenant)
  const clientId = requireExactValue('--client-id', values['client-id'])
  const connectionName = requireExactValue('--connection', values.connection)
  if (tenant.includes('/') || !tenant.includes('.')) throw new Error('--tenant must be an exact Auth0 tenant hostname')

  return {
    tenant,
    clientId,
    connectionName,
    apply: values.apply ?? false,
    allowTestEmailProvider: values['allow-test-email-provider'] ?? false,
  }
}

function requireExactValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} is required`)
  if (value !== value.trim()) throw new Error(`${flag} must not contain leading or trailing whitespace`)
  return value
}

export function assertDatabaseConnectionCompatible(connection: JsonObject, users: JsonObject[]): void {
  if (connection.strategy !== 'auth0') {
    throw new Error(`connection '${connection.name}' must use the auth0 database strategy`)
  }
  if (
    connection.options?.enabledDatabaseCustomization ||
    (connection.options?.customScripts && Object.keys(connection.options.customScripts).length > 0) ||
    (connection.options?.custom_scripts && Object.keys(connection.options.custom_scripts).length > 0)
  ) {
    throw new Error(
      `connection '${connection.name}' is a custom database connection and cannot be migrated automatically`,
    )
  }
  const attributes = connection.options?.attributes ?? {}
  if (connection.options?.requires_username || attributes.username?.identifier?.active) {
    throw new Error(`connection '${connection.name}' has an active username identifier`)
  }
  if (attributes.phone_number?.identifier?.active) {
    throw new Error(`connection '${connection.name}' has an active phone number identifier`)
  }
  if (connection.options?.authentication_methods?.passkey?.enabled) {
    throw new Error(`connection '${connection.name}' has passkey authentication enabled`)
  }
  if (connection.options?.attributes == null) {
    throw new Error(
      `connection '${connection.name}' must activate Auth0's New Attributes Configuration in Dashboard > Authentication > Database > ${connection.name} > Attributes before applying`,
    )
  }

  const userWithoutEmail = users.find((user) => !user.email)
  if (userWithoutEmail) {
    throw new Error(`database user '${userWithoutEmail.user_id ?? 'unknown'}' has no email`)
  }
}

export function buildDatabaseConnectionUpdate(connection: JsonObject): JsonObject {
  const options = structuredClone(connection.options ?? {})
  const existingEmail = options.attributes?.email ?? {}
  options.disable_signup = false
  options.disable_self_service_change_password = false
  options.authentication_methods = {
    ...(options.authentication_methods ?? {}),
    password: {
      ...(options.authentication_methods?.password ?? {}),
      enabled: true,
      signup_behavior: 'allow',
    },
  }
  options.attributes = {
    ...(options.attributes ?? {}),
    email: {
      ...existingEmail,
      identifier: { ...(existingEmail.identifier ?? {}), active: true, default_method: 'password' },
      profile_required: true,
      signup: {
        ...(existingEmail.signup ?? {}),
        status: 'required',
        verification: { ...(existingEmail.signup?.verification ?? {}), active: true },
      },
      unique: true,
      verification_method: 'otp',
    },
  }

  return {
    options,
  }
}

export function buildPromptUpdate(prompt: JsonObject): JsonObject {
  return {
    ...structuredClone(prompt),
    universal_login_experience: 'new',
    identifier_first: true,
  }
}

export function buildLoginPolicyBindings(actionId: string, existingBindings: JsonObject[]): JsonObject[] {
  if (!actionId) throw new Error('login policy Action id is required')
  const preserved = existingBindings
    .filter(
      (binding) =>
        binding.action?.id &&
        binding.action.id !== actionId &&
        binding.display_name !== RESOURCE_NAMES.action &&
        binding.display_name !== LEGACY_ACTION_NAME,
    )
    .map((binding) => ({ ref: { type: 'action_id', value: binding.action.id }, display_name: binding.display_name }))

  return [...preserved, { ref: { type: 'action_id', value: actionId }, display_name: RESOURCE_NAMES.action }]
}

export function emailDeliveryReadiness(
  provider: JsonObject | null,
  verifyTemplate: JsonObject | null,
  resetTemplate: JsonObject | null,
  allowTestEmailProvider: boolean,
): {
  externalEmailProvider: boolean
  auth0BuiltInEmailProvider: boolean
  verifyEmailByCodeTemplate: boolean
  resetEmailByCodeTemplate: boolean
  readyToApply: boolean
} {
  const externalEmailProvider = Boolean(
    provider && provider.enabled !== false && provider.name && provider.name !== 'auth0',
  )
  const auth0BuiltInEmailProvider = Boolean(
    allowTestEmailProvider && (provider === null || (provider.name === 'auth0' && provider.enabled !== false)),
  )
  const verifyEmailByCodeTemplate = verifyTemplate?.enabled === true
  const resetEmailByCodeTemplate = resetTemplate?.enabled === true

  return {
    externalEmailProvider,
    auth0BuiltInEmailProvider,
    verifyEmailByCodeTemplate,
    resetEmailByCodeTemplate,
    readyToApply:
      auth0BuiltInEmailProvider || (externalEmailProvider && verifyEmailByCodeTemplate && resetEmailByCodeTemplate),
  }
}

export function assertEmailDeliveryReady(readiness: ReturnType<typeof emailDeliveryReadiness>): void {
  if (readiness.readyToApply) return
  if (!readiness.externalEmailProvider) {
    throw new Error(
      'an enabled external Auth0 email provider is required; use --allow-test-email-provider only for a non-production canary tenant',
    )
  }
  if (!readiness.verifyEmailByCodeTemplate) {
    throw new Error("Auth0 email template 'verify_email_by_code' must exist and be enabled")
  }
  throw new Error("Auth0 email template 'reset_email_by_code' must exist and be enabled")
}

interface EmailVerificationResourceIds {
  generateFlowId: string
  verifyFlowId: string
  vaultConnectionId: string
}

export function hydrateEmailVerificationTemplate(template: JsonObject, ids: EmailVerificationResourceIds): JsonObject {
  const replacements: Record<string, string> = {
    '#FLOW-1#': ids.generateFlowId,
    '#FLOW-2#': ids.verifyFlowId,
    '#CONN-1#': ids.vaultConnectionId,
  }
  const serialized = JSON.stringify(template).replace(
    /#(?:FLOW-[12]|CONN-1)#/g,
    (placeholder) => replacements[placeholder],
  )
  const remainingPlaceholder = serialized.match(/#(?:FLOW|CONN)-[^"}]+#/)
  if (remainingPlaceholder) throw new Error(`unresolved Auth0 Form placeholder: ${remainingPlaceholder[0]}`)
  return JSON.parse(serialized)
}

export function hydrateLoginPolicyAction(
  source: string,
  values: { clientId: string; connectionName: string; formId: string },
): string {
  const replacements: Record<string, string> = {
    __BOXLITE_CLIENT_ID_JSON__: JSON.stringify(values.clientId),
    __BOXLITE_DB_CONNECTION_JSON__: JSON.stringify(values.connectionName),
    __EMAIL_VERIFICATION_FORM_ID_JSON__: JSON.stringify(values.formId),
  }
  const hydrated = source.replace(
    /__(?:BOXLITE_CLIENT_ID|BOXLITE_DB_CONNECTION|EMAIL_VERIFICATION_FORM_ID)_JSON__/g,
    (placeholder) => replacements[placeholder],
  )
  const unresolved = hydrated.match(/__[A-Z_]+_JSON__/)
  if (unresolved) throw new Error(`unresolved Auth0 Action placeholder: ${unresolved[0]}`)
  return hydrated
}

export interface Auth0ManagementClient {
  request(
    method: HttpMethod,
    path: string,
    options?: { data?: JsonBody; query?: Record<string, string>; allowNotFound?: boolean },
  ): JsonObject | JsonObject[] | null
}

type Auth0CommandRunner = (
  command: string,
  args: string[],
  options: {
    input?: string
    encoding: 'utf8'
    stdio: ['pipe' | 'ignore', 'pipe', 'pipe']
    timeout: number
    killSignal: NodeJS.Signals
  },
) => string

class Auth0ManagementApiError extends Error {
  readonly statusCode: number | undefined
  readonly errorCode: string | undefined
  readonly apiMessage: string | undefined

  constructor(
    message: string,
    metadata: { statusCode?: number; errorCode?: string; apiMessage?: string },
    cause: Error,
  ) {
    super(message, { cause })
    this.name = 'Auth0ManagementApiError'
    this.statusCode = metadata.statusCode
    this.errorCode = metadata.errorCode
    this.apiMessage = metadata.apiMessage
    Object.defineProperty(this, 'apiMessage', {
      value: metadata.apiMessage,
      enumerable: false,
    })
  }
}

/** Authenticated Management API transport using the official Auth0 CLI session. */
export class Auth0CliManagementClient implements Auth0ManagementClient {
  constructor(
    private readonly tenant: string,
    private readonly runCommand: Auth0CommandRunner = (command, args, options) => execFileSync(command, args, options),
  ) {}

  request(
    method: HttpMethod,
    path: string,
    options: { data?: JsonBody; query?: Record<string, string>; allowNotFound?: boolean } = {},
  ): JsonObject | JsonObject[] | null {
    const args = ['api', method, path, '--tenant', this.tenant, '--no-input', '--no-color']
    for (const [name, value] of Object.entries(options.query ?? {})) {
      // The Auth0 CLI requires Lucene search syntax to arrive encoded, but
      // treats encoded comma-separated `fields` as a literal field name.
      const cliValue = name === 'q' ? encodeURIComponent(value) : value
      args.push('--query', `${name}=${cliValue}`)
    }
    if (method === 'delete') args.push('--force')

    try {
      const stdout = this.runCommand('auth0', args, {
        input: options.data ? JSON.stringify(options.data) : undefined,
        encoding: 'utf8',
        stdio: [options.data ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        killSignal: 'SIGTERM',
      }).trim()
      return stdout ? JSON.parse(stdout) : null
    } catch (cause: any) {
      const stderr = cause.stderr?.toString() ?? ''
      if (options.allowNotFound && /(?:404|not found)/i.test(stderr)) return null
      const apiFailure = parseAuth0CliApiFailure(stderr)
      const status = apiFailure.statusCode ?? Number(stderr.match(/(?:status code|status):?\s*(\d{3})/i)?.[1])
      const scopeAdvice =
        status === 403
          ? `; re-run \`npm run auth0:login-policy-login\` to request: ${LOGIN_POLICY_MANAGEMENT_SCOPES.join(',')}`
          : ''
      const safeCause = new Error(
        `auth0 CLI exited with ${typeof cause.status === 'number' ? `status ${cause.status}` : 'an execution error'}`,
      )
      throw new Auth0ManagementApiError(
        `Auth0 ${method.toUpperCase()} ${path} failed${status ? ` (${status})` : ''}${scopeAdvice}`,
        apiFailure,
        safeCause,
      )
    }
  }
}

interface Auth0LoginPolicySources {
  actionCode: string
  emailVerificationTemplate: JsonObject
  journalDirectory: string
}

interface PolicyState {
  client: JsonObject
  clientConnections: JsonObject[]
  connection: JsonObject | null
  users: JsonObject[]
  provider: JsonObject | null
  verifyTemplate: JsonObject | null
  resetTemplate: JsonObject | null
  prompt: JsonObject
  managementClient: JsonObject | null
  clientGrant: JsonObject | null
  vaultConnection: JsonObject | null
  generateFlow: JsonObject | null
  verifyFlow: JsonObject | null
  form: JsonObject | null
  action: JsonObject | null
  bindings: JsonObject[]
}

interface JournalEntry {
  kind: string
  path: string
  id?: string
  created: boolean
  previous?: JsonBody
  restoreMethod?: 'patch'
  redeploy?: boolean
}

interface Auth0LoginPolicyJournal {
  version: 1
  tenant: string
  clientId: string
  connectionName: string
  createdAt: string
  entries: JournalEntry[]
}

export class Auth0LoginPolicyConfigurator {
  private journal: Auth0LoginPolicyJournal | null = null
  private journalPath: string | null = null

  constructor(
    private readonly options: Auth0LoginPolicyOptions,
    private readonly client: Auth0ManagementClient,
    private readonly sources: Auth0LoginPolicySources,
  ) {}

  preview(): JsonObject {
    const state = this.readState()
    this.assertStateAdoptable(state)
    const emailReadiness = emailDeliveryReadiness(
      state.provider,
      state.verifyTemplate,
      state.resetTemplate,
      this.options.allowTestEmailProvider,
    )

    return {
      mode: 'preview',
      tenant: this.options.tenant,
      client: {
        id: state.client.client_id ?? state.client.id,
        name: state.client.name,
        app_type: state.client.app_type,
      },
      connection: {
        name: this.options.connectionName,
        id: state.connection?.id ?? null,
        change: state.connection ? 'update' : 'create',
        usersChecked: state.users.length,
      },
      prerequisites: {
        externalEmailProvider: emailReadiness.externalEmailProvider,
        auth0BuiltInEmailProvider: emailReadiness.auth0BuiltInEmailProvider,
        verifyEmailByCodeTemplate: emailReadiness.verifyEmailByCodeTemplate,
        resetEmailByCodeTemplate: emailReadiness.resetEmailByCodeTemplate,
      },
      resources: {
        managementClient: resourceStatus(state.managementClient),
        clientGrant: resourceStatus(state.clientGrant),
        vaultConnection: resourceStatus(state.vaultConnection),
        generateFlow: resourceStatus(state.generateFlow),
        verifyFlow: resourceStatus(state.verifyFlow),
        form: resourceStatus(state.form),
        action: resourceStatus(state.action),
        actionBound: state.bindings.some((binding) => binding.action?.id === state.action?.id),
      },
      readyToApply: emailReadiness.readyToApply,
    }
  }

  apply(): JsonObject {
    const state = this.readState()
    this.assertProductionEmailReady(state)
    this.assertStateAdoptable(state)
    this.beginJournal()

    try {
      this.updatePrompt(state.prompt)
      const connection = this.ensureDatabaseConnection(state.connection)
      this.updateDatabaseConnection(connection)
      const managementClient = this.ensureManagementClient(state.managementClient)
      this.ensureClientGrant(managementClient, state.clientGrant)
      const vaultConnection = this.ensureVaultConnection(managementClient, state.vaultConnection)
      const generateFlow = this.ensureFlow(
        RESOURCE_NAMES.generateFlow,
        hydrateForVault(
          this.sources.emailVerificationTemplate.flows['#FLOW-1#'],
          requireResourceId('vault connection', vaultConnection),
        ),
        state.generateFlow,
      )
      const verifyFlow = this.ensureFlow(
        RESOURCE_NAMES.verifyFlow,
        hydrateForVault(
          this.sources.emailVerificationTemplate.flows['#FLOW-2#'],
          requireResourceId('vault connection', vaultConnection),
        ),
        state.verifyFlow,
      )
      const hydratedTemplate = hydrateEmailVerificationTemplate(this.sources.emailVerificationTemplate, {
        generateFlowId: requireResourceId('generate flow', generateFlow),
        verifyFlowId: requireResourceId('verify flow', verifyFlow),
        vaultConnectionId: requireResourceId('vault connection', vaultConnection),
      })
      const form = this.ensureForm(hydratedTemplate.form, state.form)

      this.enableConnectionForClient(connection, state.clientConnections)
      const action = this.ensureAction(requireResourceId('verification form', form), state.action)
      if (!state.action) this.deployAction(action)
      this.bindAction(action, state.bindings)

      const readBack = this.readState()
      this.assertApplied(readBack)
      return {
        mode: 'applied',
        tenant: this.options.tenant,
        connectionId: readBack.connection?.id,
        formId: readBack.form?.id,
        actionId: readBack.action?.id,
        journal: this.journalPath,
      }
    } catch (cause) {
      throw new Error(
        `Auth0 login policy apply stopped; roll back with \`npm run auth0:configure-login -- --rollback ${JSON.stringify(this.journalPath)}\``,
        { cause },
      )
    }
  }

  static rollback(journalPath: string, clientFactory: (tenant: string) => Auth0ManagementClient): JsonObject {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Auth0LoginPolicyJournal
    if (journal.version !== 1 || !journal.tenant || !Array.isArray(journal.entries)) {
      throw new Error(`invalid Auth0 login policy journal '${journalPath}'`)
    }
    const client = clientFactory(journal.tenant)
    const failures: string[] = []

    for (const entry of [...journal.entries].reverse()) {
      try {
        if (entry.created) {
          client.request('delete', `${entry.path}/${requireJournalId(entry)}`)
          continue
        }
        if (entry.previous) {
          const restorePath = entry.id ? `${entry.path}/${entry.id}` : entry.path
          client.request(entry.restoreMethod ?? 'patch', restorePath, { data: entry.previous })
          if (entry.redeploy && entry.id) client.request('post', `${entry.path}/${entry.id}/deploy`, { data: {} })
        }
      } catch {
        failures.push(`${entry.kind}:${entry.id ?? entry.path}`)
      }
    }

    if (failures.length > 0) {
      throw new Error(`Auth0 rollback incomplete for ${failures.join(', ')}`)
    }
    return { mode: 'rolled-back', tenant: journal.tenant, entries: journal.entries.length }
  }

  private readState(): PolicyState {
    const client = this.requireClient()
    const connections = this.readAllResources('connections', 'connections')
    const clientConnections = this.readClientConnections()
    const otherDatabaseConnection = clientConnections.find(
      (candidate) => candidate.strategy === 'auth0' && candidate.name !== this.options.connectionName,
    )
    if (otherDatabaseConnection) {
      throw new Error(
        `BoxLite client '${this.options.clientId}' is also enabled on database connection '${otherDatabaseConnection.name}'`,
      )
    }
    const connection = this.readResourceDetail(
      'database connection',
      'connections',
      uniqueNamed(connections, this.options.connectionName, 'database connection'),
    )
    const users = connection ? this.readAllDatabaseUsers(connection.name) : []
    if (connection) assertDatabaseConnectionCompatible(connection, users)

    const provider = objectOrNull(this.client.request('get', 'emails/provider', { allowNotFound: true }))
    const verifyTemplate = objectOrNull(
      this.client.request('get', 'email-templates/verify_email_by_code', { allowNotFound: true }),
    )
    const resetTemplate = objectOrNull(
      this.client.request('get', 'email-templates/reset_email_by_code', { allowNotFound: true }),
    )
    const prompt = requireObject('prompt settings', this.client.request('get', 'prompts'))
    const clients = this.readAllResources('clients', 'clients')
    const managementClientSummary = uniqueNamed(clients, RESOURCE_NAMES.managementClient, 'management client')
    const managementClient = managementClientSummary
      ? requireObject(
          'management client',
          this.client.request('get', `clients/${encodeURIComponent(requireClientId(managementClientSummary))}`),
        )
      : null
    const grants = this.readAllResources('client-grants', 'client_grants')
    const clientGrant = managementClient
      ? (grants.find(
          (grant) =>
            grant.client_id === (managementClient.client_id ?? managementClient.id) &&
            grant.audience === `https://${this.options.tenant}${MANAGEMENT_AUDIENCE_SUFFIX}`,
        ) ?? null)
      : null
    const vaultConnections = this.readAllResources('flows/vault/connections', 'connections')
    const flows = this.readAllResources('flows', 'flows')
    const forms = this.readAllResources('forms', 'forms')
    const actions = this.readAllResources('actions/actions', 'actions')
    const bindingsResponse = requireObject(
      'post-login bindings',
      this.client.request('get', 'actions/triggers/post-login/bindings'),
    )

    return {
      client,
      clientConnections,
      connection,
      users,
      provider,
      verifyTemplate,
      resetTemplate,
      prompt,
      managementClient,
      clientGrant,
      vaultConnection: this.readResourceDetail(
        'vault connection',
        'flows/vault/connections',
        uniqueNamed(vaultConnections, RESOURCE_NAMES.vaultConnection, 'vault connection'),
      ),
      generateFlow: this.readResourceDetail(
        'generate OTP flow',
        'flows',
        uniqueNamed(flows, RESOURCE_NAMES.generateFlow, 'generate OTP flow'),
      ),
      verifyFlow: this.readResourceDetail(
        'verify OTP flow',
        'flows',
        uniqueNamed(flows, RESOURCE_NAMES.verifyFlow, 'verify OTP flow'),
      ),
      form: this.readResourceDetail(
        'verification form',
        'forms',
        uniqueNamed(forms, RESOURCE_NAMES.form, 'verification form'),
      ),
      action: this.readResourceDetail(
        'login policy action',
        'actions/actions',
        uniqueNamed(actions, RESOURCE_NAMES.action, 'login policy action'),
      ),
      bindings: collection(bindingsResponse.bindings ?? [], 'bindings'),
    }
  }

  private requireClient(): JsonObject {
    const client = objectOrNull(
      this.client.request('get', `clients/${encodeURIComponent(this.options.clientId)}`, { allowNotFound: true }),
    )
    if (!client) throw new Error(`Auth0 client '${this.options.clientId}' does not exist in ${this.options.tenant}`)
    if (client.app_type !== 'spa') throw new Error(`Auth0 client '${this.options.clientId}' must be a SPA application`)
    return client
  }

  private readAllResources(path: string, key: string): JsonObject[] {
    const resources: JsonObject[] = []
    for (let page = 0; page < 10; page += 1) {
      const response = this.client.request('get', path, {
        query: { per_page: '100', page: String(page) },
      })
      const batch = collection(response, key)
      resources.push(...batch)
      const total = objectOrNull(response)?.total
      if (batch.length < 100 || (typeof total === 'number' && resources.length >= total)) return resources
    }
    throw new Error(`Auth0 ${path} discovery exceeded 1,000 resources`)
  }

  private readClientConnections(): JsonObject[] {
    const connections: JsonObject[] = []
    let from: string | undefined
    for (let page = 0; page < 100; page += 1) {
      const query: Record<string, string> = { take: '100', strategy: 'auth0' }
      if (from) query.from = from
      const response = requireObject(
        'enabled client connections',
        this.client.request('get', `clients/${encodeURIComponent(this.options.clientId)}/connections`, { query }),
      )
      connections.push(...collection(response, 'connections'))
      if (!response.next) return connections
      if (response.next === from) throw new Error('Auth0 enabled-client connection pagination did not advance')
      from = response.next
    }
    throw new Error(`Auth0 enabled connections for client '${this.options.clientId}' exceeded 100,000 resources`)
  }

  private readResourceDetail(kind: string, path: string, summary: JsonObject | null): JsonObject | null {
    if (!summary) return null
    const id = requireResourceId(kind, summary)
    return requireObject(kind, this.client.request('get', `${path}/${encodeURIComponent(id)}`))
  }

  private readAllDatabaseUsers(connectionName: string): JsonObject[] {
    const users: JsonObject[] = []
    for (let page = 0; page < 10; page += 1) {
      const response = this.client.request('get', 'users', {
        query: {
          q: `identities.connection:"${escapeAuth0Search(connectionName)}"`,
          search_engine: 'v3',
          per_page: '100',
          page: String(page),
          include_totals: 'true',
        },
      })
      const batch = collection(response, 'users')
      users.push(...batch)
      const total = objectOrNull(response)?.total
      if (batch.length < 100 || (typeof total === 'number' && users.length >= total)) return users
    }
    throw new Error(`database user preflight exceeded Auth0's 1,000-user search window for '${connectionName}'`)
  }

  private assertProductionEmailReady(state: PolicyState): void {
    assertEmailDeliveryReady(
      emailDeliveryReadiness(
        state.provider,
        state.verifyTemplate,
        state.resetTemplate,
        this.options.allowTestEmailProvider,
      ),
    )
  }

  private assertStateAdoptable(state: PolicyState): void {
    if (state.managementClient) this.assertManagementClientCompatible(state.managementClient)
    if (state.vaultConnection) {
      if (!state.managementClient) {
        throw new Error(`Auth0 vault connection '${RESOURCE_NAMES.vaultConnection}' has no managed M2M client`)
      }
      this.assertVaultConnectionOwned(state.vaultConnection)
    }

    if (state.generateFlow || state.verifyFlow) {
      if (!state.vaultConnection || !state.generateFlow || !state.verifyFlow) {
        throw new Error('Auth0 has an incomplete set of BoxLite-managed email verification flows')
      }
      this.assertManagedFlowMatches(
        state.generateFlow,
        hydrateForVault(
          this.sources.emailVerificationTemplate.flows['#FLOW-1#'],
          requireResourceId('vault connection', state.vaultConnection),
        ),
      )
      this.assertManagedFlowMatches(
        state.verifyFlow,
        hydrateForVault(
          this.sources.emailVerificationTemplate.flows['#FLOW-2#'],
          requireResourceId('vault connection', state.vaultConnection),
        ),
      )
    }

    if (state.form) {
      if (!state.vaultConnection || !state.generateFlow || !state.verifyFlow) {
        throw new Error(`Auth0 Form '${RESOURCE_NAMES.form}' has no complete managed dependency set`)
      }
      const desired = hydrateEmailVerificationTemplate(this.sources.emailVerificationTemplate, {
        generateFlowId: requireResourceId('generate flow', state.generateFlow),
        verifyFlowId: requireResourceId('verify flow', state.verifyFlow),
        vaultConnectionId: requireResourceId('vault connection', state.vaultConnection),
      }).form
      this.assertManagedFormMatches(state.form, desired)
    }

    if (state.action) {
      if (!state.form) throw new Error(`Auth0 Action '${RESOURCE_NAMES.action}' has no managed verification Form`)
      assertManagedActionMatches(
        state.action,
        this.actionPayload(requireResourceId('verification form', state.form)),
        true,
      )
    }
  }

  private ensureDatabaseConnection(existing: JsonObject | null): JsonObject {
    if (existing) return existing
    const created = requireObject(
      'database connection',
      this.writeDatabaseConnection('post', 'connections', {
        name: this.options.connectionName,
        strategy: 'auth0',
        ...buildDatabaseConnectionUpdate({ options: {} }),
      }),
    )
    this.recordCreated('database connection', 'connections', requireResourceId('database connection', created))
    return created
  }

  private writeDatabaseConnection(method: 'post' | 'patch', path: string, data: JsonObject): JsonObject | null {
    for (let attempt = 1; attempt <= DATABASE_CONNECTION_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return objectOrNull(this.client.request(method, path, { data }))
      } catch (cause) {
        if (!isIdentifierFirstPropagationError(cause) || attempt === DATABASE_CONNECTION_WRITE_ATTEMPTS) throw cause

        // Auth0's prompt PATCH can become readable before database-connection
        // validation observes it. Each bounded read-back is also the delay
        // between retries; no other connection-write failure is retried.
        this.client.request('get', 'prompts')
      }
    }
    throw new Error(`Auth0 ${method.toUpperCase()} ${path} exhausted its retry budget`)
  }

  private updateDatabaseConnection(connection: JsonObject): void {
    const id = requireResourceId('database connection', connection)
    const update = buildDatabaseConnectionUpdate(connection)
    if (containsJson(connectionUpdateSnapshot(connection), update)) return

    this.recordAdopted('database connection', 'connections', id, connectionUpdateSnapshot(connection))
    this.writeDatabaseConnection('patch', `connections/${id}`, update)
  }

  private enableConnectionForClient(connection: JsonObject, clientConnections: JsonObject[]): void {
    const connectionId = requireResourceId('database connection', connection)
    if (clientConnections.some((candidate) => candidate.id === connectionId)) return
    const path = `connections/${connectionId}/clients`
    this.recordAdopted('connection client binding', path, undefined, [
      { client_id: this.options.clientId, status: false },
    ])
    this.client.request('patch', path, {
      data: [{ client_id: this.options.clientId, status: true }],
    })
  }

  private ensureManagementClient(existing: JsonObject | null): JsonObject {
    if (existing) {
      this.assertManagementClientCompatible(existing)
      return existing
    }

    const created = requireObject(
      'management client',
      this.client.request('post', 'clients', {
        data: {
          name: RESOURCE_NAMES.managementClient,
          app_type: 'non_interactive',
          token_endpoint_auth_method: 'client_secret_post',
          client_metadata: MANAGEMENT_CLIENT_METADATA,
        },
      }),
    )
    this.recordCreated('management client', 'clients', requireClientId(created))
    return created
  }

  private assertManagementClientCompatible(client: JsonObject): void {
    if (
      client.app_type !== 'non_interactive' ||
      client.token_endpoint_auth_method !== 'client_secret_post' ||
      !containsJson(client.client_metadata, MANAGEMENT_CLIENT_METADATA)
    ) {
      throw new Error(
        `Auth0 client '${RESOURCE_NAMES.managementClient}' is not the dedicated BoxLite email-verification M2M application`,
      )
    }
  }

  private ensureClientGrant(managementClient: JsonObject, existing: JsonObject | null): void {
    const audience = `https://${this.options.tenant}${MANAGEMENT_AUDIENCE_SUFFIX}`
    if (!existing) {
      const created = requireObject(
        'client grant',
        this.client.request('post', 'client-grants', {
          data: {
            client_id: requireClientId(managementClient),
            audience,
            scope: MANAGEMENT_CLIENT_SCOPES,
          },
        }),
      )
      this.recordCreated('client grant', 'client-grants', requireResourceId('client grant', created))
      return
    }

    const id = requireResourceId('client grant', existing)
    const desired = { scope: MANAGEMENT_CLIENT_SCOPES, allow_all_scopes: false }
    if (sameJson(existing.scope ?? [], desired.scope) && existing.allow_all_scopes !== true) return
    this.recordAdopted('client grant', 'client-grants', id, {
      scope: existing.scope ?? [],
      allow_all_scopes: existing.allow_all_scopes ?? false,
    })
    this.client.request('patch', `client-grants/${id}`, { data: desired })
  }

  private ensureVaultConnection(managementClient: JsonObject, existing: JsonObject | null): JsonObject {
    if (existing) {
      this.assertVaultConnectionOwned(existing)
      return existing
    }
    const clientId = requireClientId(managementClient)
    const clientWithSecret = managementClient.client_secret
      ? managementClient
      : requireObject(
          'management client secret',
          this.client.request('get', `clients/${clientId}`, {
            query: { fields: 'client_id,client_secret', include_fields: 'true' },
          }),
        )
    if (!clientWithSecret.client_secret) {
      throw new Error(`Auth0 did not return the secret for management client '${clientId}'; rotate it, then retry`)
    }

    const created = requireObject(
      'vault connection',
      this.client.request('post', 'flows/vault/connections', {
        data: {
          name: RESOURCE_NAMES.vaultConnection,
          app_id: 'AUTH0',
          setup: {
            type: 'OAUTH_APP',
            client_id: clientId,
            client_secret: clientWithSecret.client_secret,
            domain: this.options.tenant,
            audience: `https://${this.options.tenant}${MANAGEMENT_AUDIENCE_SUFFIX}`,
          },
        },
      }),
    )
    this.recordCreated('vault connection', 'flows/vault/connections', requireResourceId('vault connection', created))
    return created
  }

  private assertVaultConnectionOwned(vaultConnection: JsonObject): void {
    const id = requireResourceId('vault connection', vaultConnection)
    if (
      vaultConnection.app_id !== 'AUTH0' ||
      vaultConnection.ready !== true ||
      !this.wasCreatedByJournal('vault connection', 'flows/vault/connections', id)
    ) {
      throw new Error(
        `Auth0 vault connection '${RESOURCE_NAMES.vaultConnection}' is not a ready, journal-owned BoxLite resource`,
      )
    }
  }

  private ensureFlow(name: string, desired: JsonObject, existing: JsonObject | null): JsonObject {
    const payload = { name, actions: desired.actions }
    if (!existing) {
      const created = requireObject('flow', this.client.request('post', 'flows', { data: payload }))
      this.recordCreated('flow', 'flows', requireResourceId('flow', created))
      return created
    }

    this.assertManagedFlowMatches(existing, payload)
    return existing
  }

  private assertManagedFlowMatches(existing: JsonObject, desired: JsonObject): void {
    if (!sameJson(flowSnapshot(existing), flowSnapshot(desired))) {
      throw new Error(`Auth0 flow '${existing.name}' already exists with unmanaged contents`)
    }
  }

  private ensureForm(desired: JsonObject, existing: JsonObject | null): JsonObject {
    const payload = formSnapshot(desired)
    if (!existing) {
      const created = requireObject('verification form', this.client.request('post', 'forms', { data: payload }))
      this.recordCreated('verification form', 'forms', requireResourceId('verification form', created))
      return created
    }

    this.assertManagedFormMatches(existing, payload)
    return existing
  }

  private assertManagedFormMatches(existing: JsonObject, desired: JsonObject): void {
    if (!sameJson(formSnapshot(existing), formSnapshot(desired))) {
      throw new Error(`Auth0 Form '${RESOURCE_NAMES.form}' already exists with unmanaged contents`)
    }
  }

  private updatePrompt(existing: JsonObject): void {
    const update = buildPromptUpdate(existing)
    if (sameJson(existing, update)) return

    this.recordAdopted('prompt settings', 'prompts', undefined, promptRollbackSnapshot(existing))
    this.client.request('patch', 'prompts', { data: update })
  }

  private ensureAction(formId: string, existing: JsonObject | null): JsonObject {
    const payload = this.actionPayload(formId)
    if (!existing) {
      const created = requireObject(
        'login policy action',
        this.client.request('post', 'actions/actions', { data: payload }),
      )
      this.recordCreated('login policy action', 'actions/actions', requireResourceId('login policy action', created))
      return created
    }

    assertManagedActionMatches(existing, payload, true)
    return existing
  }

  private actionPayload(formId: string): JsonObject {
    return {
      name: RESOURCE_NAMES.action,
      supported_triggers: [{ id: 'post-login', version: 'v3' }],
      code: hydrateLoginPolicyAction(this.sources.actionCode, {
        clientId: this.options.clientId,
        connectionName: this.options.connectionName,
        formId,
      }),
      runtime: 'node22',
    }
  }

  private deployAction(action: JsonObject): void {
    this.client.request('post', `actions/actions/${requireResourceId('login policy action', action)}/deploy`, {
      data: {},
    })
  }

  private bindAction(action: JsonObject, existingBindings: JsonObject[]): void {
    const actionId = requireResourceId('login policy action', action)
    const previous = { bindings: bindingsSnapshot(existingBindings) }
    this.recordAdopted('post-login bindings', 'actions/triggers/post-login/bindings', undefined, previous)
    this.client.request('patch', 'actions/triggers/post-login/bindings', {
      data: { bindings: buildLoginPolicyBindings(actionId, existingBindings) },
    })
  }

  private assertApplied(state: PolicyState): void {
    if (
      !state.connection ||
      !state.managementClient ||
      !state.clientGrant ||
      !state.vaultConnection ||
      !state.generateFlow ||
      !state.verifyFlow ||
      !state.form ||
      !state.action
    ) {
      throw new Error('Auth0 read-back is missing a required resource')
    }
    this.assertProductionEmailReady(state)
    const desiredConnection = buildDatabaseConnectionUpdate(state.connection)
    if (!containsJson(connectionUpdateSnapshot(state.connection), desiredConnection)) {
      throw new Error('Auth0 database connection read-back does not contain the desired policy')
    }
    if (!state.clientConnections.some((candidate) => candidate.id === state.connection?.id)) {
      throw new Error('Auth0 database connection read-back is not enabled for the BoxLite client')
    }
    if (state.prompt.identifier_first !== true || state.prompt.universal_login_experience !== 'new') {
      throw new Error('Auth0 prompt read-back is not Identifier First New Universal Login')
    }
    this.assertManagementClientCompatible(state.managementClient)
    if (
      state.clientGrant.audience !== `https://${this.options.tenant}${MANAGEMENT_AUDIENCE_SUFFIX}` ||
      !sameJson(state.clientGrant.scope ?? [], MANAGEMENT_CLIENT_SCOPES) ||
      state.clientGrant.allow_all_scopes === true
    ) {
      throw new Error('Auth0 management client grant read-back lacks the required scope or audience')
    }
    this.assertVaultConnectionOwned(state.vaultConnection)

    const hydratedTemplate = hydrateEmailVerificationTemplate(this.sources.emailVerificationTemplate, {
      generateFlowId: requireResourceId('generate flow', state.generateFlow),
      verifyFlowId: requireResourceId('verify flow', state.verifyFlow),
      vaultConnectionId: requireResourceId('vault connection', state.vaultConnection),
    })
    const desiredGenerateFlow = hydrateForVault(
      this.sources.emailVerificationTemplate.flows['#FLOW-1#'],
      requireResourceId('vault connection', state.vaultConnection),
    )
    const desiredVerifyFlow = hydrateForVault(
      this.sources.emailVerificationTemplate.flows['#FLOW-2#'],
      requireResourceId('vault connection', state.vaultConnection),
    )
    if (!containsJson(flowSnapshot(state.generateFlow), flowSnapshot(desiredGenerateFlow))) {
      throw new Error('Auth0 generate-OTP flow read-back does not match the managed flow')
    }
    if (!containsJson(flowSnapshot(state.verifyFlow), flowSnapshot(desiredVerifyFlow))) {
      throw new Error('Auth0 verify-OTP flow read-back does not match the managed flow')
    }
    if (!containsJson(formSnapshot(state.form), formSnapshot(hydratedTemplate.form))) {
      throw new Error('Auth0 verification Form read-back does not match the managed graph')
    }
    assertManagedActionMatches(
      state.action,
      {
        name: RESOURCE_NAMES.action,
        supported_triggers: [{ id: 'post-login', version: 'v3' }],
        code: hydrateLoginPolicyAction(this.sources.actionCode, {
          clientId: this.options.clientId,
          connectionName: this.options.connectionName,
          formId: requireResourceId('verification form', state.form),
        }),
        runtime: 'node22',
      },
      true,
    )
    if (!state.bindings.some((binding) => binding.action?.id === state.action?.id)) {
      throw new Error('Auth0 login policy Action is not bound to post-login')
    }
  }

  private beginJournal(): void {
    mkdirSync(this.sources.journalDirectory, { recursive: true, mode: 0o700 })
    const suffix = new Date().toISOString().replace(/[:.]/g, '-')
    this.journalPath = join(this.sources.journalDirectory, `${suffix}-auth0-login-policy.json`)
    this.journal = {
      version: 1,
      tenant: this.options.tenant,
      clientId: this.options.clientId,
      connectionName: this.options.connectionName,
      createdAt: new Date().toISOString(),
      entries: [],
    }
    this.flushJournal()
  }

  private recordCreated(kind: string, path: string, id: string): void {
    this.record({ kind, path, id, created: true })
  }

  private recordAdopted(
    kind: string,
    path: string,
    id: string | undefined,
    previous: JsonBody,
    redeploy = false,
  ): void {
    assertJournalSnapshotSafe(kind, previous)
    this.record({
      kind,
      path,
      id,
      created: false,
      previous: structuredClone(previous),
      restoreMethod: 'patch',
      redeploy,
    })
  }

  private record(entry: JournalEntry): void {
    if (!this.journal) throw new Error('Auth0 rollback journal is not initialized')
    this.journal.entries.push(entry)
    this.flushJournal()
  }

  private flushJournal(): void {
    if (!this.journal || !this.journalPath) throw new Error('Auth0 rollback journal is not initialized')
    writeFileSync(this.journalPath, `${JSON.stringify(this.journal, null, 2)}\n`, { mode: 0o600 })
  }

  private wasCreatedByJournal(kind: string, path: string, id: string): boolean {
    if (!existsSync(this.sources.journalDirectory)) return false
    for (const filename of readdirSync(this.sources.journalDirectory)) {
      if (!filename.endsWith('-auth0-login-policy.json')) continue
      try {
        const journal = JSON.parse(
          readFileSync(join(this.sources.journalDirectory, filename), 'utf8'),
        ) as Auth0LoginPolicyJournal
        if (
          journal.version === 1 &&
          journal.tenant === this.options.tenant &&
          journal.clientId === this.options.clientId &&
          journal.connectionName === this.options.connectionName &&
          journal.entries?.some(
            (entry) => entry.created && entry.kind === kind && entry.path === path && entry.id === id,
          )
        ) {
          return true
        }
      } catch {
        // An unreadable or malformed file is not ownership evidence.
      }
    }
    return false
  }
}

function resourceStatus(resource: JsonObject | null): JsonObject {
  return resource ? { change: 'update', id: resource.id ?? resource.client_id } : { change: 'create', id: null }
}

function parseAuth0CliApiFailure(stderr: string): {
  statusCode?: number
  errorCode?: string
  apiMessage?: string
} {
  const serialized = stderr.match(/API request failed:\s*(\{[^\r\n]*\})\.?/i)?.[1]
  if (!serialized) return {}
  try {
    const response = JSON.parse(serialized)
    return {
      statusCode: typeof response.statusCode === 'number' ? response.statusCode : undefined,
      errorCode: typeof response.errorCode === 'string' ? response.errorCode : undefined,
      apiMessage: typeof response.message === 'string' ? response.message : undefined,
    }
  } catch {
    return {}
  }
}

function isIdentifierFirstPropagationError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false
  const apiFailure = cause as Error & {
    statusCode?: number
    errorCode?: string
    apiMessage?: string
  }
  const message = apiFailure.apiMessage ?? apiFailure.message
  return (
    message === IDENTIFIER_FIRST_PROPAGATION_ERROR &&
    (apiFailure.statusCode == null || apiFailure.statusCode === 400) &&
    (apiFailure.errorCode == null || apiFailure.errorCode === 'invalid_body')
  )
}

function collection(value: JsonObject | JsonObject[] | null | undefined, key: string): JsonObject[] {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value[key])) return value[key]
  return []
}

function objectOrNull(value: JsonObject | JsonObject[] | null | undefined): JsonObject | null {
  return value && !Array.isArray(value) ? value : null
}

function requireObject(name: string, value: JsonObject | JsonObject[] | null): JsonObject {
  const object = objectOrNull(value)
  if (!object) throw new Error(`Auth0 returned no ${name}`)
  return object
}

function uniqueNamed(resources: JsonObject[], name: string, kind: string): JsonObject | null {
  const matches = resources.filter((resource) => resource.name === name)
  if (matches.length > 1) throw new Error(`Auth0 has duplicate ${kind} resources named '${name}'`)
  return matches[0] ?? null
}

function requireResourceId(name: string, resource: JsonObject): string {
  if (!resource.id) throw new Error(`Auth0 ${name} has no id`)
  return resource.id
}

function requireClientId(client: JsonObject): string {
  const id = client.client_id ?? client.id
  if (!id) throw new Error('Auth0 client has no client_id')
  return id
}

function requireJournalId(entry: JournalEntry): string {
  if (!entry.id) throw new Error(`rollback entry '${entry.kind}' has no id`)
  return entry.id
}

function escapeAuth0Search(value: string): string {
  return value.replace(/[\\"]/g, '\\$&')
}

function hydrateForVault(value: JsonObject, vaultConnectionId: string): JsonObject {
  return JSON.parse(JSON.stringify(value).replaceAll('#CONN-1#', vaultConnectionId))
}

function connectionUpdateSnapshot(connection: JsonObject): JsonObject {
  return {
    options: structuredClone(connection.options ?? {}),
  }
}

function promptRollbackSnapshot(prompt: JsonObject): JsonObject {
  return {
    ...structuredClone(prompt),
    identifier_first: prompt.identifier_first === true,
  }
}

function flowSnapshot(flow: JsonObject): JsonObject {
  return { name: flow.name, actions: structuredClone(flow.actions ?? []) }
}

function formSnapshot(form: JsonObject): JsonObject {
  return {
    name: form.name,
    languages: structuredClone(form.languages),
    nodes: structuredClone(form.nodes),
    start: structuredClone(form.start),
    ending: structuredClone(form.ending),
  }
}

function bindingsSnapshot(bindings: JsonObject[]): JsonObject[] {
  return bindings
    .filter((binding) => binding.action?.id)
    .map((binding) => ({ ref: { type: 'action_id', value: binding.action.id }, display_name: binding.display_name }))
}

function assertManagedActionMatches(action: JsonObject, desired: JsonObject, requireDeployed: boolean): void {
  if (!containsJson(action, desired)) {
    throw new Error(
      `Auth0 Action '${RESOURCE_NAMES.action}' already exists with unmanaged contents; remove it or restore its BoxLite-managed definition before applying`,
    )
  }
  if ((action.secrets?.length ?? 0) > 0 || (action.deployed_version?.secrets?.length ?? 0) > 0) {
    throw new Error(`Auth0 Action '${RESOURCE_NAMES.action}' contains secrets and cannot be adopted safely`)
  }
  if (
    requireDeployed &&
    (action.all_changes_deployed !== true ||
      action.deployed_version?.deployed !== true ||
      action.deployed_version?.code !== desired.code ||
      action.deployed_version?.runtime !== desired.runtime)
  ) {
    throw new Error(`Auth0 Action '${RESOURCE_NAMES.action}' read-back is not the deployed managed version`)
  }
}

export function assertJournalSnapshotSafe(kind: string, value: unknown, path = kind): void {
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertJournalSnapshotSafe(kind, nested, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/-/g, '_')
        .toLowerCase()
      const isPasswordMethodConfig =
        normalizedKey === 'password' &&
        path.endsWith('.authentication_methods') &&
        Boolean(nested && typeof nested === 'object' && !Array.isArray(nested))
      if (
        !isPasswordMethodConfig &&
        (/^(?:authorization|credentials?)$/.test(normalizedKey) ||
          /(?:^|_)(?:password|passphrase|secret|token|api_key|credentials?|private_key)$/.test(normalizedKey))
      ) {
        throw new Error(`refusing to journal ${kind}: credential-like field '${path}.${key}'`)
      }
      assertJournalSnapshotSafe(kind, nested, `${path}.${key}`)
    }
    return
  }
  if (
    typeof value === 'string' &&
    (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/i.test(value) ||
      /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/.test(value))
  ) {
    throw new Error(`refusing to journal ${kind}: credential-like value at '${path}'`)
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function containsJson(actual: any, desired: any): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      desired.length === actual.length &&
      desired.every((value, index) => containsJson(actual[index], value))
    )
  }
  if (desired && typeof desired === 'object') {
    return Boolean(
      actual &&
      typeof actual === 'object' &&
      Object.entries(desired).every(([key, value]) => containsJson(actual[key], value)),
    )
  }
  return actual === desired
}
