// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Auth0McpConfigurator, parseAuth0McpOptions } from './auth0-mcp.js'

const RESOURCE = 'https://api.example.test/mcp'
const CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata'
const SCOPES = ['write:boxes', 'delete:boxes']

/** An in-memory tenant answering the Management API paths the configurator uses. */
function fakeTenant(rules: object[] = []) {
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
    request(method: string, path: string, options: { data?: any; query?: Record<string, string> } = {}) {
      if (method !== 'get') writes.push(`${method} ${path}`)
      const data = options.data
      if (method === 'get' && path === 'rules') return rules
      if (path === 'tenants/settings') return method === 'get' ? state.settings : Object.assign(state.settings, data)
      if (path === 'resource-servers') {
        if (method === 'get') return state.apis
        const api = { id: `rs_${++next}`, ...data }
        state.apis.push(api)
        return api
      }
      if (path.startsWith('resource-servers/')) {
        const api = state.apis.find((a) => path.endsWith(a.id))
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
        if (method === 'get') return state.grants.filter((g) => g.audience === options.query?.audience)
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
    },
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
