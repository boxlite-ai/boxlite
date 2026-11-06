// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Auth0McpConfigurator, parseAuth0McpOptions } from './auth0-mcp.js'

const RESOURCE = 'https://api.example.test/api/mcp'
const CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata'
const SCOPES = ['write:boxes', 'delete:boxes']

type RequestOptions = { data?: any; query?: Record<string, string>; allowNotFound?: boolean }

/** One page of a list, as the Management API pages it (`per_page` defaults to 50). */
function page<T>(items: T[], query: Record<string, string> = {}): T[] {
  const size = Number(query.per_page ?? 50)
  const index = Number(query.page ?? 0)
  return items.slice(index * size, (index + 1) * size)
}

/**
 * An in-memory tenant answering the Management API paths the configurator uses.
 * `lose` names one write (`post resource-servers`) whose change lands but whose
 * response is lost, as on a dropped connection.
 */
function fakeTenant(rules: object[] = [], lose?: string) {
  const state = {
    settings: { resource_parameter_profile: 'audience', client_id_metadata_document_supported: false } as Record<string, any>,
    apis: [] as Record<string, any>[],
    clients: new Set<string>(),
    grants: [] as Record<string, any>[],
    connections: [{ id: 'con_1', name: 'Username-Password-Authentication', is_domain_connection: false }],
  }
  const writes: string[] = []
  let next = 0
  const client = {
    request(method: string, path: string, options: RequestOptions = {}) {
      const result = answer(method, path, options)
      if (`${method} ${path}` === lose) throw new Error('socket hang up')
      return result
    },
  }
  function answer(method: string, path: string, options: RequestOptions) {
      if (method !== 'get') writes.push(`${method} ${path}`)
      const data = options.data
      if (method === 'get' && path === 'rules') return page(rules, options.query)
      if (path === 'tenants/settings') return method === 'get' ? state.settings : Object.assign(state.settings, data)
      if (path === 'resource-servers') {
        if (method === 'get') return page(state.apis, options.query)
        const api = { id: `rs_${++next}`, ...data }
        state.apis.push(api)
        return api
      }
      if (path.startsWith('resource-servers/')) {
        // Read by id or by identifier, as the Management API allows.
        const key = decodeURIComponent(path.slice('resource-servers/'.length))
        const api = state.apis.find((a) => a.id === key || a.identifier === key)
        if (method === 'get') {
          if (!api && !options.allowNotFound) throw new Error(`404 ${path}`)
          return api ?? null
        }
        if (method === 'delete') state.apis = state.apis.filter((a) => a !== api)
        else Object.assign(api!, data)
        return api
      }
      if (path === 'clients/cimd/preview') return {}
      if (path === 'clients/cimd/register') return state.clients.add(data.external_client_id) && { client_id: data.external_client_id }
      if (path.startsWith('clients/')) {
        const id = decodeURIComponent(path.slice('clients/'.length))
        if (method === 'delete') return state.clients.delete(id) && null
        return state.clients.has(id) ? { client_id: id } : null
      }
      if (path === 'client-grants') {
        if (method === 'get') {
          const { audience, client_id } = options.query ?? {}
          const matching = state.grants.filter(
            (g) => (!audience || g.audience === audience) && (!client_id || g.client_id === client_id),
          )
          return page(matching, options.query)
        }
        const grant = { id: `cgr_${++next}`, ...data }
        state.grants.push(grant)
        return grant
      }
      if (path.startsWith('client-grants/')) {
        state.grants = state.grants.filter((g) => !path.endsWith(g.id))
        return null
      }
      if (path === 'connections') return state.connections.filter((c) => c.name === options.query?.name)
      if (path.startsWith('connections/')) return Object.assign(state.connections.find((c) => path.endsWith(c.id))!, data)
      throw new Error(`unexpected ${method} ${path}`)
  }
  return { state, writes, client }
}

function configurator(tenant: ReturnType<typeof fakeTenant>, apply: boolean, journalDirectory: string) {
  return new Auth0McpConfigurator(
    { tenant: 't.example.auth0.com', resourceUrl: RESOURCE, connections: ['Username-Password-Authentication'], apply },
    tenant.client as never,
    { scopes: SCOPES, clients: [CLIENT], journalDirectory },
  )
}

test('preview lists every write and changes nothing', () => {
  const tenant = fakeTenant()
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  try {
    const preview = configurator(tenant, false, dir).preview()

    assert.deepEqual(
      preview.writes.map((w: any) => w.kind),
      ['tenant settings', 'MCP API', `client ${CLIENT}`, `grant ${CLIENT}`, 'connection Username-Password-Authentication'],
    )
    assert.deepEqual(tenant.writes, ['post clients/cimd/preview'])
    assert.equal(tenant.state.apis.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply reaches the desired state, a rerun writes nothing, and rollback restores the tenant', () => {
  const tenant = fakeTenant()
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  try {
    const applied = configurator(tenant, true, dir).apply()

    assert.equal(tenant.state.settings.resource_parameter_profile, 'compatibility')
    assert.equal(tenant.state.settings.client_id_metadata_document_supported, true)
    assert.deepEqual(tenant.state.apis[0].subject_type_authorization, {
      user: { policy: 'require_client_grant' },
      client: { policy: 'deny_all' },
    })
    assert.ok(tenant.state.clients.has(CLIENT))
    assert.deepEqual(tenant.state.grants[0], {
      id: tenant.state.grants[0].id,
      client_id: CLIENT,
      audience: RESOURCE,
      scope: SCOPES,
      subject_type: 'user',
    })
    assert.equal(tenant.state.connections[0].is_domain_connection, true)
    assert.deepEqual(configurator(tenant, false, dir).preview().writes, [])

    Auth0McpConfigurator.rollback(applied.journal, () => tenant.client as never)

    assert.equal(tenant.state.settings.resource_parameter_profile, 'audience')
    assert.equal(tenant.state.apis.length, 0)
    assert.equal(tenant.state.clients.size, 0)
    assert.equal(tenant.state.grants.length, 0)
    assert.equal(tenant.state.connections[0].is_domain_connection, false)
    assert.equal(JSON.parse(readFileSync(applied.journal, 'utf8')).entries.length, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('advertises RFC 9207 issuer identification and rollback turns it back off', () => {
  const tenant = fakeTenant()
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  try {
    const applied = configurator(tenant, true, dir).apply()
    assert.equal(tenant.state.settings.authorization_response_iss_parameter_supported, true)

    Auth0McpConfigurator.rollback(applied.journal, () => tenant.client as never)
    assert.equal(tenant.state.settings.authorization_response_iss_parameter_supported, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finds the MCP API past the first page instead of creating it again', () => {
  const tenant = fakeTenant()
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  try {
    configurator(tenant, true, dir).apply()
    const mcp = tenant.state.apis.pop()!
    for (let i = 0; i < 60; i += 1) tenant.state.apis.push({ id: `rs_other_${i}`, identifier: `https://other-${i}.test` })
    tenant.state.apis.push(mcp)

    assert.deepEqual(configurator(tenant, false, dir).preview().writes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('revokes the grant of a client dropped from the list, sparing every other grant', () => {
  const tenant = fakeTenant()
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  const dropped = 'https://old.example.test/oauth/client.json'
  try {
    configurator(tenant, true, dir).apply()
    const listed = tenant.state.grants.find((g) => g.client_id === CLIENT)!
    const others = [
      { id: 'cgr_dashboard', client_id: 'spa_dashboard', audience: RESOURCE, scope: SCOPES, subject_type: 'user' },
      { id: 'cgr_elsewhere', client_id: dropped, audience: 'https://other.test/api', scope: [], subject_type: 'user' },
    ]
    const stale = { id: 'cgr_stale', client_id: dropped, audience: RESOURCE, scope: SCOPES, subject_type: 'user' }
    tenant.state.grants.push(...others, stale)

    const applied = configurator(tenant, true, dir).apply()

    assert.deepEqual(tenant.state.grants.map((g) => g.id).sort(), [listed.id, ...others.map((g) => g.id)].sort())
    Auth0McpConfigurator.rollback(applied.journal, () => tenant.client as never)
    const { id: _id, ...restored } = tenant.state.grants.find((g) => g.client_id === dropped && g.audience === RESOURCE) ?? {}
    assert.deepEqual(restored, { client_id: dropped, audience: RESOURCE, scope: SCOPES, subject_type: 'user' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rollback deletes an API whose create response was lost', () => {
  const tenant = fakeTenant([], 'post resource-servers')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  try {
    assert.throws(() => configurator(tenant, true, dir).apply(), /socket hang up/)
    assert.equal(tenant.state.apis.length, 1)
    const [journal] = readdirSync(dir)

    Auth0McpConfigurator.rollback(join(dir, journal), () => tenant.client as never)

    assert.equal(tenant.state.apis.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses a tenant with active Rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  try {
    assert.throws(() => configurator(fakeTenant([{ id: 'rul_1' }]), false, dir).preview(), /active Rule/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseAuth0McpOptions requires an exact https resource URL and a connection', () => {
  const base = ['--tenant', 't.example.auth0.com', '--resource-url', RESOURCE]

  assert.equal(parseAuth0McpOptions([...base, '--connection', 'db']).apply, false)
  assert.throws(() => parseAuth0McpOptions(base), /--connection/)
  assert.throws(() => parseAuth0McpOptions(['--tenant', 't.example.auth0.com', '--resource-url', 'http://x/mcp', '--connection', 'db']))
})
