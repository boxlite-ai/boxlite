/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegistriesService } from '../../../registry/services/registries.service'
import { RegistryTools } from './registry-tools'
import {
  accessFixture,
  caller,
  FOREIGN_ORGANIZATION_ID,
  ORGANIZATION_ID,
  RESOURCE_ID,
  toolHarness,
} from '../../tests/tool-harness'

const PASSWORD = 'secret-value-do-not-return'
const REQUEST = {
  organization_id: ORGANIZATION_ID,
  registry_host: 'ghcr.io',
  repository_prefix: 'acme/',
  username: 'bot',
  password: PASSWORD,
}
const NAMES = ['list_registries', 'create_registry', 'delete_registry']

describe('MCP registry tools', () => {
  let fixture: ReturnType<typeof accessFixture>
  let harness: Awaited<ReturnType<typeof toolHarness>>
  let registries: { list: jest.Mock; create: jest.Mock; delete: jest.Mock }
  const credential = {
    id: RESOURCE_ID,
    organizationId: ORGANIZATION_ID,
    registryHost: 'ghcr.io',
    repositoryPrefix: 'acme/',
    username: 'bot',
    createdBy: 'member',
    createdAt: new Date('2026-01-01'),
    secretVersion: 'private-secret-store-version',
    password: PASSWORD,
  }

  beforeEach(async () => {
    fixture = accessFixture()
    registries = {
      list: jest.fn().mockResolvedValue([credential]),
      create: jest.fn().mockResolvedValue(credential),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    const tools = new RegistryTools(fixture.access, registries as unknown as RegistriesService, fixture.audit)
    harness = await toolHarness((server) => tools.register(server, caller))
  })
  afterEach(async () => {
    await harness.close()
  })

  function args(name: string) {
    return name === 'create_registry'
      ? REQUEST
      : { organization_id: ORGANIZATION_ID, ...(name === 'delete_registry' ? { registry_id: RESOURCE_ID } : {}) }
  }

  it('advertises strict public outputs without password or secret-store fields', async () => {
    const { result } = await harness.list()
    expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...NAMES].sort())
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.outputSchema.anyOf[0].additionalProperties).toBe(false)
      expect(JSON.stringify(tool.outputSchema)).not.toContain('password')
      expect(JSON.stringify(tool.outputSchema)).not.toContain('secretVersion')
    }
  })
  it.each(NAMES)('requires actual membership before %s', async (name) => {
    fixture.memberships.findOne.mockResolvedValue(null)
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    for (const operation of Object.values(registries)) expect(operation).not.toHaveBeenCalled()
  })
  it.each(NAMES)('checks resource roles before %s', async (name) => {
    fixture.member.assignedRoles = []
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    for (const operation of Object.values(registries)) expect(operation).not.toHaveBeenCalled()
  })
  it('maps list/create into the exact safe REST projection and audits no secrets', async () => {
    const expected = {
      id: RESOURCE_ID,
      registry_host: 'ghcr.io',
      repository_prefix: 'acme/',
      username: 'bot',
      created_by: 'member',
      created_at: '2026-01-01T00:00:00.000Z',
    }
    const listing = (await harness.call('list_registries', args('list_registries'))).result
    expect(listing.structuredContent).toEqual({ registries: [expected] })
    expect(JSON.parse(listing.content[0].text)).toEqual(listing.structuredContent)
    const created = (await harness.call('create_registry', REQUEST)).result
    expect(created.structuredContent).toEqual(expected)
    expect(registries.create).toHaveBeenCalledWith(ORGANIZATION_ID, caller.userId, {
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
      username: 'bot',
      password: PASSWORD,
    })
    expect(fixture.auditService.createLog.mock.invocationCallOrder[0]).toBeLessThan(
      registries.create.mock.invocationCallOrder[0],
    )
    for (const serialized of [
      JSON.stringify(created),
      JSON.stringify(listing),
      JSON.stringify(fixture.auditService.createLog.mock.calls),
      JSON.stringify(fixture.auditService.updateLog.mock.calls),
    ]) {
      expect(serialized).not.toContain(PASSWORD)
      expect(serialized).not.toContain('private-secret-store-version')
    }
  })
  it('deletes only after scoped metadata confirms ownership', async () => {
    expect((await harness.call('delete_registry', args('delete_registry'))).result.structuredContent).toEqual({
      completed: true,
    })
    expect(registries.list).toHaveBeenCalledWith(ORGANIZATION_ID)
    expect(registries.delete).toHaveBeenCalledWith(ORGANIZATION_ID, RESOURCE_ID)
    expect(fixture.auditService.createLog.mock.invocationCallOrder[0]).toBeLessThan(
      registries.delete.mock.invocationCallOrder[0],
    )
  })
  it.each([{ credentials: [] }, { credentials: [{ ...credential, organizationId: FOREIGN_ORGANIZATION_ID }] }])(
    'denies missing/foreign credential metadata before deletion',
    async ({ credentials }) => {
      registries.list.mockResolvedValue(credentials)
      const { result } = await harness.call('delete_registry', args('delete_registry'))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('Resource not found or not accessible')
      expect(registries.delete).not.toHaveBeenCalled()
      expect(fixture.auditService.createLog).not.toHaveBeenCalled()
    },
  )
  it('sanitizes backend failures containing sensitive details in results and audits', async () => {
    registries.create.mockRejectedValue(new Error(PASSWORD + ' private-secret-store-version'))
    const body = await harness.call('create_registry', REQUEST)
    expect(body.result.content[0].text).toBe('Tool operation failed')
    expect(body.result.structuredContent.error.source).toBe('service')
    expect(JSON.stringify(body)).not.toContain(PASSWORD)
    expect(JSON.stringify(fixture.auditService.updateLog.mock.calls)).not.toContain(PASSWORD)
  })
  it('rejects unsupported registry hosts, invalid prefixes, invalid IDs and unknown options before access', async () => {
    for (const request of [
      { ...REQUEST, registry_host: 'unsupported.example' },
      { ...REQUEST, repository_prefix: '../' },
      { ...REQUEST, secretVersion: 'injected' },
    ]) {
      const body = await harness.call('create_registry', request)
      expect(body.error || body.result?.isError).toBeTruthy()
    }
    const body = await harness.call('delete_registry', { organization_id: ORGANIZATION_ID, registry_id: 'invalid' })
    expect(body.error || body.result?.isError).toBeTruthy()
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
  })
})
