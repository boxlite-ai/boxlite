/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { createMcpServer } from './mcp-server'
import { McpRest } from './mcp-rest'

const openapi = parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8'))

describe('MCP OpenAPI operation selection', () => {
  const rest = new McpRest({ findDefaultForUser: jest.fn() } as any)

  it.each([
    ['/{prefix}/boxes', 'get'],
    ['/{prefix}/boxes', 'post'],
    ['/{prefix}/boxes/{box_id}', 'get'],
    ['/{prefix}/boxes/{box_id}', 'delete'],
    ['/{prefix}/boxes/{box_id}/start', 'post'],
    ['/{prefix}/boxes/{box_id}/stop', 'post'],
  ])('rejects a contract missing %s %s before advertising an incomplete catalog', async (path, method) => {
    const document = structuredClone(openapi)
    delete document.paths[path][method]
    await expect(createMcpServer(document, rest)).rejects.toThrow('Missing required MCP Box operation')
  })

  it('rejects a contract without paths', async () => {
    const document = structuredClone(openapi)
    delete document.paths
    await expect(createMcpServer(document, rest)).rejects.toThrow('Missing required MCP Box operation')
  })

  it('rejects duplicate selected operation IDs instead of silently replacing a tool', async () => {
    const document = structuredClone(openapi)
    document.paths['/{prefix}/duplicate'] = { get: document.paths['/{prefix}/boxes/{box_id}'].get }
    await expect(createMcpServer(document, rest)).rejects.toThrow('Duplicate MCP operation: getBox')
  })
})
