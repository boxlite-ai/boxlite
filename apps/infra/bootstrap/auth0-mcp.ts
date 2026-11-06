// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  type Auth0ManagementClient,
  deployedActionGatesBoxLite,
  LOGIN_POLICY_ACTION_NAME,
  readAllPages,
} from './auth0-login-policy.js'

type JsonObject = Record<string, any>

export interface Auth0McpOptions {
  tenant: string
  /** `MCP_RESOURCE_URL`: the MCP endpoint's resource, and the MCP API's identifier. */
  resourceUrl: string
  /** `OIDC_AUDIENCE`: the BoxLite API the live login Action must also gate. */
  apiAudience: string
  /** Connections MCP clients may sign in with; each becomes a domain-level connection. */
  connections: string[]
  apply: boolean
}

export interface Auth0McpSources {
  /** Scopes the MCP API defines and every client grant allows (the API's `MCP_OAUTH_SCOPES`). */
  scopes: string[]
  /** Client ID Metadata Document URLs of the reviewed MCP clients. */
  clients: string[]
  journalDirectory: string
}

/** One write, with what rollback needs to undo it. */
interface JournalEntry {
  kind: string
  method: 'post' | 'patch' | 'delete'
  path: string
  data: JsonObject
  /** The fields' values before a `patch`, or the resource a `delete` removed; restored by rollback. */
  previous?: JsonObject
  /** Set before the write is sent, so rollback knows a `post` may have landed even without a response. */
  attempted?: boolean
  /** For a `post`, the path rollback deletes; filled after the write. */
  created?: string
}

const TENANT_SETTINGS = {
  resource_parameter_profile: 'compatibility',
  client_id_metadata_document_supported: true,
  // RFC 9207: an `iss` in every authorization response. ChatGPT then uses its
  // stable `https://chatgpt.com/oauth/client.json` client ID instead of a
  // per-callback one this allowlist cannot name.
  authorization_response_iss_parameter_supported: true,
}

/** What a tenant that never set a flag reports for it: Auth0 omits a setting that is off. */
const TENANT_SETTINGS_DEFAULTS = { authorization_response_iss_parameter_supported: false }

export function parseAuth0McpOptions(argv: string[]): Auth0McpOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      tenant: { type: 'string' },
      'resource-url': { type: 'string' },
      'api-audience': { type: 'string' },
      connection: { type: 'string', multiple: true },
      apply: { type: 'boolean', default: false },
    },
  })
  const tenant = values.tenant ?? ''
  if (!tenant || tenant.includes('/') || !tenant.includes('.')) throw new Error('--tenant must be an exact Auth0 tenant hostname')
  const resourceUrl = values['resource-url'] ?? ''
  if (!/^https:\/\//.test(resourceUrl) || new URL(resourceUrl).href !== resourceUrl) {
    throw new Error('--resource-url must be the exact https MCP_RESOURCE_URL')
  }
  const apiAudience = values['api-audience'] ?? ''
  if (!apiAudience) throw new Error('--api-audience is required: the OIDC_AUDIENCE the login Action gates')
  if (!values.connection?.length) throw new Error('--connection is required, once per connection MCP clients sign in with')
  return { tenant, resourceUrl, apiAudience, connections: values.connection, apply: values.apply ?? false }
}

export function loadMcpSources(bootstrapRoot: string): Omit<Auth0McpSources, 'journalDirectory'> {
  const file = JSON.parse(readFileSync(join(bootstrapRoot, 'auth0', 'mcp-clients.json'), 'utf8'))
  return { scopes: file.scopes, clients: file.clients }
}

/**
 * Lets a tenant issue MCP-audience tokens to the reviewed MCP clients only:
 * an MCP API whose user access needs a client grant and whose machine access is
 * off, the `resource` parameter profile and CIMD on, one registered client and
 * one user grant per allowlisted metadata document, and domain-level connections
 * so those third-party clients can sign in. Dynamic registration stays off.
 *
 * `preview` reads and lists the writes; `apply` journals each write's before
 * values under `.sst/auth0-backups/` first, so `rollback` can undo a run.
 */
export class Auth0McpConfigurator {
  constructor(
    private readonly options: Auth0McpOptions,
    private readonly client: Auth0ManagementClient,
    private readonly sources: Auth0McpSources,
  ) {}

  preview(): JsonObject {
    return { mode: 'preview', tenant: this.options.tenant, writes: this.plan().map(({ kind, method, path }) => ({ kind, method, path })) }
  }

  apply(): JsonObject {
    const writes = this.plan()
    mkdirSync(this.sources.journalDirectory, { recursive: true, mode: 0o700 })
    const journalPath = join(this.sources.journalDirectory, `mcp-${this.options.tenant}-${Date.now()}.json`)
    const save = () =>
      writeFileSync(journalPath, `${JSON.stringify({ version: 1, tenant: this.options.tenant, entries: writes }, null, 2)}\n`, {
        mode: 0o600,
      })
    save()
    for (const write of writes) {
      write.attempted = true
      save()
      // A client registered earlier in this run has its id only now.
      if (write.path === 'client-grants' && write.method === 'post') {
        write.data = { ...write.data, client_id: cimdClientId(this.client, write.data.client_id) }
        save()
      }
      const data = write.method === 'delete' ? undefined : write.data
      const result = this.client.request(write.method, write.path, { data }) as JsonObject | null
      if (write.method === 'post') write.created = createdPath(write, result)
      save()
    }
    return { mode: 'applied', tenant: this.options.tenant, writes: writes.length, journal: journalPath }
  }

  static rollback(journalPath: string, clientFactory: (tenant: string) => Auth0ManagementClient): JsonObject {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    if (journal.version !== 1 || !journal.tenant || !Array.isArray(journal.entries)) {
      throw new Error(`invalid Auth0 MCP journal '${journalPath}'`)
    }
    const client = clientFactory(journal.tenant)
    for (const entry of [...(journal.entries as JournalEntry[])].reverse()) {
      if (entry.method === 'post') {
        // A `post` sent without a response may still have landed: find what it made.
        const created = entry.created ?? (entry.attempted ? findCreated(client, entry) : undefined)
        if (created) client.request('delete', created)
      } else if (entry.method === 'delete') {
        // A delete that failed before landing left the grant in place; re-creating it would duplicate it.
        const sent = entry.attempted && entry.previous
        if (sent && !findCreated(client, { ...entry, path: collectionOf(entry.path), data: entry.previous! })) {
          client.request('post', collectionOf(entry.path), { data: entry.previous })
        }
      } else if (entry.previous) {
        client.request('patch', entry.path, { data: entry.previous })
      }
    }
    return { mode: 'rolled-back', tenant: journal.tenant, entries: journal.entries.length }
  }

  /** The writes that bring the tenant to the desired state; empty once it is there. */
  private plan(): JournalEntry[] {
    this.assertLoginActionGatesMcp()
    const rules = readAllPages(this.client, 'rules', 'rules', { enabled: 'true' })
    if (rules.length > 0) {
      throw new Error(`${rules.length} active Rule(s) on ${this.options.tenant}: CIMD logins fail while Rules run`)
    }
    return [...this.tenantWrites(), ...this.apiWrites(), ...this.clientWrites(), ...this.connectionWrites()]
  }

  /**
   * The API leaves email verification to the login Action (#2404), so an MCP API
   * on a tenant whose live, bound Action skips this resource would admit
   * unverified database users.
   */
  private assertLoginActionGatesMcp(): void {
    const action = readAllPages(this.client, 'actions/actions', 'actions').find(
      (candidate) => candidate.name === LOGIN_POLICY_ACTION_NAME,
    )
    const response = this.client.request('get', 'actions/triggers/post-login/bindings') as JsonObject | null
    const bindings = (response?.bindings ?? []) as JsonObject[]
    const bound = action !== undefined && bindings.some((binding) => binding.action?.id === action.id)
    const { apiAudience, resourceUrl, tenant } = this.options
    if (!bound || !deployedActionGatesBoxLite(action, apiAudience, resourceUrl)) {
      throw new Error(
        `Auth0 Action '${LOGIN_POLICY_ACTION_NAME}' on ${tenant} does not gate MCP logins for ${resourceUrl} and the API ${apiAudience}; ` +
          `run auth0:configure-login with --api-audience ${apiAudience} --mcp-resource-url ${resourceUrl} first`,
      )
    }
  }

  private tenantWrites(): JournalEntry[] {
    const read = (this.client.request('get', 'tenants/settings') ?? {}) as JsonObject
    const settings = { ...TENANT_SETTINGS_DEFAULTS, ...read }
    return patchIfChanged('tenant settings', 'tenants/settings', settings, TENANT_SETTINGS)
  }

  private apiWrites(): JournalEntry[] {
    const desired = {
      scopes: this.sources.scopes.map((value) => ({ value, description: `BoxLite ${value}` })),
      subject_type_authorization: { user: { policy: 'require_client_grant' }, client: { policy: 'deny_all' } },
    }
    // Read by its identifier, which the Management API accepts in place of the id.
    const path = `resource-servers/${encodeURIComponent(this.options.resourceUrl)}`
    const existing = this.client.request('get', path, { allowNotFound: true }) as JsonObject | null
    if (!existing) {
      return [
        {
          kind: 'MCP API',
          method: 'post',
          path: 'resource-servers',
          data: { name: 'BoxLite MCP', identifier: this.options.resourceUrl, ...desired },
        },
      ]
    }
    return patchIfChanged('MCP API', `resource-servers/${existing.id}`, existing, desired)
  }

  private clientWrites(): JournalEntry[] {
    const writes: JournalEntry[] = []
    const grants = readAllPages(this.client, 'client-grants', 'client_grants', { audience: this.options.resourceUrl })
    // Auth0 gives a CIMD client its own `tpc_` id and keeps the metadata URL as
    // `external_client_id`; grants and the `clients/{id}` path take only the id.
    const cimd = readAllPages(this.client, 'clients', 'clients').filter((c) => c.external_metadata_type === 'cimd')
    const listedIds = new Set<string>()
    for (const url of this.sources.clients) {
      const registered = cimd.find((c) => c.external_client_id === url)
      if (!registered) {
        // Preview fetches and validates the document; register only what it accepts.
        this.client.request('post', 'clients/cimd/preview', { data: { external_client_id: url } })
        writes.push({ kind: `client ${url}`, method: 'post', path: 'clients/cimd/register', data: { external_client_id: url } })
      } else listedIds.add(registered.client_id)
      const grant = registered && grants.find((g) => g.client_id === registered.client_id && g.subject_type === 'user')
      // An unregistered client's grant names its URL until apply resolves the id.
      const clientId = registered?.client_id ?? url
      const data = { client_id: clientId, audience: this.options.resourceUrl, scope: this.sources.scopes, subject_type: 'user' }
      if (!grant) writes.push({ kind: `grant ${url}`, method: 'post', path: 'client-grants', data })
      else writes.push(...patchIfChanged(`grant ${url}`, `client-grants/${grant.id}`, grant, { scope: this.sources.scopes }))
    }
    // A CIMD client dropped from the list keeps no user grant. Grants of other
    // clients, and on other audiences, are not ours.
    const cimdIds = new Set(cimd.map((c) => c.client_id))
    for (const grant of grants) {
      const managed = grant.subject_type === 'user' && cimdIds.has(grant.client_id)
      if (!managed || listedIds.has(grant.client_id)) continue
      const { client_id, audience, scope, subject_type } = grant
      writes.push({
        kind: `revoke grant ${client_id}`,
        method: 'delete',
        path: `client-grants/${grant.id}`,
        data: {},
        previous: { client_id, audience, scope, subject_type },
      })
    }
    return writes
  }

  private connectionWrites(): JournalEntry[] {
    return this.options.connections.flatMap((name) => {
      const connection = this.list('connections', { name }).find((c) => c.name === name)
      if (!connection) throw new Error(`connection '${name}' not found on ${this.options.tenant}`)
      return patchIfChanged(`connection ${name}`, `connections/${connection.id}`, connection, { is_domain_connection: true })
    })
  }

  private list(path: string, query?: Record<string, string>): JsonObject[] {
    const result = this.client.request('get', path, { query })
    return Array.isArray(result) ? result : []
  }
}

/** The resource an attempted `post` made, looked up by what it was created with; undefined if none. */
function findCreated(client: Auth0ManagementClient, entry: JournalEntry): string | undefined {
  if (entry.path === 'resource-servers') {
    const path = `resource-servers/${encodeURIComponent(entry.data.identifier)}`
    const api = client.request('get', path, { allowNotFound: true }) as JsonObject | null
    return api?.id ? `resource-servers/${api.id}` : undefined
  }
  if (entry.path === 'clients/cimd/register') {
    const id = findCimdClient(client, entry.data.external_client_id)?.client_id
    return id ? `clients/${id}` : undefined
  }
  const { client_id, audience, subject_type } = entry.data
  const grants = readAllPages(client, 'client-grants', 'client_grants', { audience, client_id })
  const grant = grants.find((g) => g.subject_type === subject_type)
  return grant ? `client-grants/${grant.id}` : undefined
}

/** `client-grants/cgr_1` → `client-grants`. */
function collectionOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

/** A `patch` of the fields whose values differ, carrying their previous values for rollback. */
function patchIfChanged(kind: string, path: string, current: JsonObject, desired: JsonObject): JournalEntry[] {
  const changed = Object.keys(desired).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(desired[key]))
  if (changed.length === 0) return []
  return [
    {
      kind,
      method: 'patch',
      path,
      data: Object.fromEntries(changed.map((key) => [key, desired[key]])),
      previous: Object.fromEntries(changed.map((key) => [key, current[key] ?? null])),
    },
  ]
}

/** The CIMD client Auth0 registered for a metadata URL, if any. */
function findCimdClient(client: Auth0ManagementClient, url: string): JsonObject | undefined {
  return readAllPages(client, 'clients', 'clients', { external_client_id: url }).find((c) => c.external_client_id === url)
}

/** A grant's client id: itself, or the `tpc_` id of the CIMD client its metadata URL names. */
function cimdClientId(client: Auth0ManagementClient, clientId: string): string {
  if (!/^https:\/\//.test(clientId)) return clientId
  const id = findCimdClient(client, clientId)?.client_id
  if (typeof id !== 'string' || !id) throw new Error(`CIMD client ${clientId} is not registered`)
  return id
}

function createdPath(write: JournalEntry, result: JsonObject | null): string {
  if (write.path === 'clients/cimd/register') {
    const clientId = result?.client_id
    if (typeof clientId !== 'string' || !clientId) throw new Error(`${write.kind}: Auth0 returned no client_id`)
    return `clients/${clientId}`
  }
  const id = result?.id
  if (typeof id !== 'string' || !id) throw new Error(`${write.kind}: Auth0 returned no id`)
  return `${write.path}/${id}`
}
