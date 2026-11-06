/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import type { Request } from 'express'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_DELEGATION_HEADER, McpDelegation } from '../auth/mcp-delegation'
import type { AuthContextType } from '../common/interfaces/auth-context.interface'
import type { McpOperation } from './mcp-catalog'

/** Largest binary body a tool call sends or returns as base64. */
export const MCP_MAX_BINARY_BYTES = 8 * 1024 * 1024

/** Request headers copied from the MCP request so the REST route sees the same client. */
const FORWARDED_HEADERS = ['user-agent', 'x-boxlite-organization-id']

export interface McpRestResponse {
  status: number
  contentType: string
  json?: unknown
  body: Buffer
}

/** Thrown for tool arguments the dispatcher refuses before any route runs. */
export class McpArgumentError extends Error {}

/**
 * Runs one catalog operation through its REST route, in this process, as the
 * caller the MCP endpoint authenticated.
 *
 * The request goes to the API's own Express app through a private Unix socket
 * this process listens on, so it is a real HTTP request but never leaves the
 * process and never reaches another cluster worker. It carries no token: a
 * single-use delegation nonce stands in for the credential. `X-Forwarded-For`
 * names the MCP client, so under `trust proxy` the route's audit, throttles and
 * guards see exactly what a direct REST call from that client would.
 */
@Injectable()
export class McpDispatcher implements OnModuleDestroy {
  private socket?: Promise<{ server: http.Server; path: string; dir: string }>

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly delegation: McpDelegation,
  ) {}

  async call(op: McpOperation, args: Record<string, unknown>, mcpRequest: Request): Promise<McpRestResponse> {
    const headers: Record<string, string> = {}
    for (const name of FORWARDED_HEADERS) {
      const value = mcpRequest.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const clientChain = [mcpRequest.headers['x-forwarded-for'], mcpRequest.socket?.remoteAddress].filter(Boolean)
    if (clientChain.length) headers['x-forwarded-for'] = clientChain.join(', ')

    const query = new URLSearchParams()
    let path = op.path
    for (const param of op.params) {
      const value = args[param.name]
      if (value === undefined || value === null) continue
      if (param.in === 'path') {
        path = path.replace(`{${param.name}}`, pathSegment(param.name, value))
      } else if (param.in === 'query') {
        query.set(param.name, typeof value === 'string' ? value : JSON.stringify(value))
      } else {
        headers[param.name.toLowerCase()] = String(value)
      }
    }
    if (/\{[^}]+\}/.test(path)) {
      throw new McpArgumentError(`Missing path argument for ${op.operationId}: ${path}`)
    }

    const payload = this.body(op, args, headers)
    headers[MCP_DELEGATION_HEADER] = this.delegation.issue(mcpRequest.user as AuthContextType)
    const search = query.toString()
    return this.send(op.method.toUpperCase(), search ? `${path}?${search}` : path, headers, payload)
  }

  async onModuleDestroy(): Promise<void> {
    const socket = await this.socket
    if (!socket) return
    await new Promise((resolve) => socket.server.close(resolve))
    rmSync(socket.dir, { recursive: true, force: true })
  }

  private body(op: McpOperation, args: Record<string, unknown>, headers: Record<string, string>): Buffer | undefined {
    if (!op.body) return undefined
    if (op.body.kind === 'json') {
      if (args.body === undefined) return undefined
      headers['content-type'] = 'application/json'
      return Buffer.from(JSON.stringify(args.body))
    }
    if (typeof args.body_base64 !== 'string') return undefined
    const bytes = Buffer.from(args.body_base64, 'base64')
    if (bytes.length > MCP_MAX_BINARY_BYTES) {
      throw new McpArgumentError(`body_base64 exceeds ${MCP_MAX_BINARY_BYTES} bytes`)
    }
    headers['content-type'] = op.body.contentType
    return bytes
  }

  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload?: Buffer,
  ): Promise<McpRestResponse> {
    const { path: socketPath } = await this.listen()
    if (payload) headers['content-length'] = String(payload.length)
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath, method, path: url, headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          const body = Buffer.concat(chunks)
          const contentType = String(response.headers['content-type'] ?? '')
          let json: unknown
          if (contentType.includes('json') && body.length) {
            try {
              json = JSON.parse(body.toString('utf8'))
            } catch {
              json = undefined
            }
          }
          resolve({ status: response.statusCode ?? 500, contentType, json, body })
        })
      })
      request.on('error', reject)
      request.end(payload)
    })
  }

  /** The per-process socket, in a fresh 0700 directory, opened on first use. */
  private listen() {
    this.socket ??= new Promise((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), 'boxlite-mcp-'))
      const path = join(dir, `${randomBytes(8).toString('hex')}.sock`)
      const server = http.createServer(this.adapterHost.httpAdapter.getInstance())
      server.once('error', reject)
      server.listen(path, () => resolve({ server, path, dir }))
    })
    return this.socket
  }
}

/** Encodes one path argument; dot segments and empty values could name a different route. */
function pathSegment(name: string, value: unknown): string {
  const text = String(value)
  if (text === '' || text === '.' || text === '..') {
    throw new McpArgumentError(`Invalid value for path argument ${name}`)
  }
  return encodeURIComponent(text)
}
