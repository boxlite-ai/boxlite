/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BadRequestException } from '@nestjs/common'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import * as z from 'zod'
import { registerMcpTool } from '../tools/shared/mcp-tool'

describe('MCP structured errors across protocol eras', () => {
  let broken = false
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'error-compat', version: '0' })
      for (const shape of ['object', 'array']) {
        registerMcpTool(
          server,
          shape,
          {
            description: 'Compatibility probe',
            inputSchema: z.strictObject({}),
            outputSchema: shape === 'array' ? z.array(z.string()) : z.strictObject({ value: z.string() }),
            annotations: {},
          },
          async () => {
            if (broken) throw new BadRequestException('Choose another destination')
            return shape === 'array' ? ['payload'] : { value: 'payload' }
          },
        )
      }
      return server
    },
    { legacy: 'stateless', responseMode: 'json' },
  )
  const serve = toNodeHandler(handler)
  const server = createServer((request, response) => {
    void serve(request, response)
  })
  let url: string

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  beforeEach(() => {
    broken = false
  })
  afterAll(async () => {
    await handler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function rpc(version: string, method: string, params: Record<string, unknown>) {
    const modern = version === '2026-07-28'
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          ...(modern
            ? {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': version,
                  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
                  'io.modelcontextprotocol/clientCapabilities': {},
                },
              }
            : {}),
        },
      }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    const body = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            .slice(6),
        )
      : JSON.parse(text)
    expect(body.error).toBeUndefined()
    return body.result
  }

  it.each(['2026-07-28', '2025-03-26', '2025-06-18', '2025-11-25'])(
    'preserves successful shapes and typed errors for %s',
    async (version) => {
      const legacy = version !== '2026-07-28'
      if (legacy)
        await rpc(version, 'initialize', {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        })
      const catalog = await rpc(version, 'tools/list', {})
      for (const name of ['object', 'array']) {
        broken = false
        const success = await rpc(version, 'tools/call', { name, arguments: {} })
        const value = name === 'array' ? ['payload'] : { value: 'payload' }
        expect(success.structuredContent).toEqual(legacy && name === 'array' ? { result: value } : value)
        const advertised = catalog.tools.find((tool: { name: string }) => tool.name === name).outputSchema
        const schema = legacy && name === 'array' ? advertised.properties.result : advertised
        expect(schema.anyOf[1].properties.error.additionalProperties).toBe(false)
        broken = true
        const failure = await rpc(version, 'tools/call', { name, arguments: {} })
        const natural = {
          error: {
            source: 'service',
            operation: name,
            status: 400,
            code: 'invalid_argument',
            message: 'Choose another destination',
          },
        }
        expect(failure.isError).toBe(true)
        expect(failure.structuredContent).toEqual(legacy && name === 'array' ? { result: natural } : natural)
        expect(JSON.parse(failure.content[1].text)).toEqual(natural)
      }
    },
  )
})
