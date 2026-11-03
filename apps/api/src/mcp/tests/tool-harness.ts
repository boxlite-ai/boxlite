/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { AuthContext } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { BoxService } from '../../box/services/box.service'
import { AuditService } from '../../audit/services/audit.service'
import { McpToolAccess } from '../tools/shared/mcp-tool-access'
import { McpToolAudit } from '../tools/shared/mcp-tool-audit'

export const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
export const FOREIGN_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'
export const RESOURCE_ID = '33333333-3333-4333-8333-333333333333'
export const caller: AuthContext = { userId: 'member', email: 'member@example.test', role: SystemRole.USER }

export function accessFixture() {
  const member = {
    role: OrganizationMemberRole.MEMBER,
    assignedRoles: [{ permissions: Object.values(OrganizationResourcePermission) }],
  }
  const organization = { id: ORGANIZATION_ID }
  const memberships = { findOne: jest.fn().mockResolvedValue(member) }
  const organizations = { findOne: jest.fn().mockResolvedValue(organization) }
  const boxes = { findOneByIdOrName: jest.fn() }
  const auditService = {
    createLog: jest.fn().mockResolvedValue({ id: 'audit-id' }),
    updateLog: jest.fn().mockResolvedValue({}),
  }
  const access = new McpToolAccess(
    memberships as unknown as OrganizationUserService,
    organizations as unknown as OrganizationService,
    boxes as unknown as BoxService,
  )
  const audit = new McpToolAudit(auditService as unknown as AuditService)
  return { access, audit, member, organization, memberships, organizations, boxes, auditService }
}

/** Real SDK transport: parsing, registered callbacks, and advertised output validation all run. */
export async function toolHarness(register: (server: McpServer) => void) {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'boxlite-test', version: '0' })
      register(server)
      return server
    },
    { legacy: 'reject', responseMode: 'json' },
  )
  const serve = toNodeHandler(handler)
  const server = createServer((request, response) => {
    void serve(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
          },
        },
      }),
    })
    return response.json()
  }
  return {
    list: () => rpc('tools/list'),
    call: (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args }),
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
