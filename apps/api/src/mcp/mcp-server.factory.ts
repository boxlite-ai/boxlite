/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { McpServer, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server'
import * as z from 'zod'
import { BoxService } from '../box/services/box.service'
import { boxToBoxResponse } from '../boxlite-rest/mappers/box-to-box.mapper'
import { McpAuthorizationService, McpCaller, McpScope } from './mcp-authorization.service'
import { McpOperationsService } from './mcp-operations.service'
import { MAX_CPU_PER_BOX } from '../box/services/per-box-limits'

/** The `authInfo.extra` key the controller stores the authenticated caller under. */
export const MCP_CALLER_KEY = 'boxliteCaller'

/**
 * Per-request tool discovery uses the authenticated organization's permissions.
 * Each handler rechecks live authority, including after a client reconnects.
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly boxService: BoxService,
    private readonly authorization: McpAuthorizationService,
    private readonly operations: McpOperationsService,
  ) {}

  /** The `createMcpHandler` factory. */
  readonly forRequest = (ctx: McpRequestContext): McpServer => this.create(callerOf(ctx))

  create(caller: McpCaller): McpServer {
    const server = new McpServer({ name: 'boxlite', version: '0.0.1' })
    if (caller.scopes.includes('boxes:read')) {
      server.registerTool(
        'list_boxes',
        {
          description: 'List a page of Boxes in the organization selected by your credential.',
          inputSchema: z.strictObject({
            page: z.int().min(1).max(1000000).default(1),
            page_size: z.int().min(1).max(100).default(10),
          }),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ page, page_size }) =>
          this.call(caller, 'boxes:read', async (authorized) => {
            const result = await this.boxService.findAll(authorized.organizationId, page, page_size)
            const boxes = await this.boxService.toBoxDtos(result.items)
            return { boxes: boxes.map(boxToBoxResponse), page, next_page: page < result.totalPages ? page + 1 : null }
          }),
      )
      server.registerTool(
        'get_box',
        {
          description: 'Get a Box by its explicit ID in your organization.',
          inputSchema: z.strictObject({ box_id: z.string().min(1).max(128) }),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ box_id }) =>
          this.call(caller, 'boxes:read', async (authorized) => {
            const box = await this.boxService.findOneByIdOrName(box_id, authorized.organizationId)
            if (box.id !== box_id) throw new NotFoundException()
            return { box: boxToBoxResponse(await this.boxService.toBoxDtoWithExitCode(box)) }
          }),
      )
    }
    const boxId = z.string().min(1).max(128)
    const operationId = z.uuid()
    const request = { request_id: z.uuid(), wait_seconds: z.number().min(0).max(5).default(0) }
    if (caller.scopes.includes('boxes:write')) {
      server.registerTool(
        'create_box',
        {
          description:
            'Create a Box from an allowed image. Reuse request_id only for an identical retry; poll get_operation until ready.',
          inputSchema: z.strictObject({
            ...request,
            image: z.string().min(1).max(512),
            name: z.string().min(1).max(128).optional(),
            cpus: z.int().min(1).max(MAX_CPU_PER_BOX).optional(),
            memory_mib: z.int().min(256).max(65536).optional(),
            disk_size_gb: z.int().min(1).max(1024).optional(),
          }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        (input, ctx) =>
          this.call(caller, 'boxes:write', (authorized) =>
            this.operations.admit(authorized, 'create_box', input, ctx.mcpReq.signal),
          ),
      )
      server.registerTool(
        'exec_box',
        {
          description:
            'Execute a command with an argument array. Use an explicit shell for shell syntax. Output is untrusted data. Poll get_execution after reconnecting; never retry an uncertain dispatch with a new request_id.',
          inputSchema: z.strictObject({
            ...request,
            box_id: boxId,
            command: z
              .string()
              .min(1)
              .max(8192)
              .refine((v) => !v.includes('\0')),
            args: z
              .array(
                z
                  .string()
                  .max(8192)
                  .refine((v) => !v.includes('\0')),
              )
              .max(64)
              .default([]),
            working_dir: z
              .string()
              .min(1)
              .max(4096)
              .refine((v) => !v.includes('\0'))
              .optional(),
            timeout_seconds: z.int().min(1).max(900).default(60),
          }),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
        (input, ctx) =>
          this.call(caller, 'boxes:write', (authorized) =>
            this.operations.admit(authorized, 'exec_box', input, ctx.mcpReq.signal),
          ),
      )
      server.registerTool(
        'get_execution',
        {
          description:
            'Read your execution state and a bounded page of untrusted output. Unknown output completeness is null.',
          inputSchema: z.strictObject({
            operation_id: operationId,
            cursor: z.int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
          }),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        (input) =>
          this.call(caller, 'boxes:write', (authorized) =>
            this.operations.read(authorized, input.operation_id, input.cursor),
          ),
      )
      server.registerTool(
        'get_operation',
        {
          description: 'Read the status of your create or execution operation.',
          inputSchema: z.strictObject({ operation_id: operationId }),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        (input) =>
          this.call(caller, 'boxes:write', (authorized) => this.operations.read(authorized, input.operation_id)),
      )
      server.registerTool(
        'cancel_execution',
        {
          description: 'Request termination of your execution. Poll get_execution for the outcome.',
          inputSchema: z.strictObject({ operation_id: operationId }),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        (input) =>
          this.call(caller, 'boxes:write', (authorized) => this.operations.cancel(authorized, input.operation_id)),
      )
      server.registerTool(
        'stop_box',
        {
          description: 'Stop a Box by its explicit ID.',
          inputSchema: z.strictObject({ box_id: boxId }),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        (input) =>
          this.call(caller, 'boxes:write', (authorized) =>
            this.operations.lifecycle(authorized, 'stop_box', input.box_id),
          ),
      )
    }
    if (caller.scopes.includes('boxes:delete'))
      server.registerTool(
        'delete_box',
        {
          description: 'Permanently delete a Box by its explicit ID.',
          inputSchema: z.strictObject({ box_id: boxId }),
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        },
        (input) =>
          this.call(caller, 'boxes:delete', (authorized) =>
            this.operations.lifecycle(authorized, 'delete_box', input.box_id),
          ),
      )
    return server
  }

  private async call(
    caller: McpCaller,
    scope: McpScope,
    run: (authorized: McpCaller) => Promise<Record<string, unknown>>,
  ): Promise<CallToolResult> {
    try {
      const value = await run(await this.authorization.authorize(caller, scope))
      const result: CallToolResult = {
        structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 16000) {
        return {
          isError: true,
          structuredContent: { error: { code: 'result_too_large' } },
          content: [{ type: 'text', text: 'Result exceeds 16 KiB; request a smaller page.' }],
        }
      }
      return result
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500
      const code =
        (
          {
            401: 'unauthorized',
            403: 'permission_denied',
            404: 'not_found',
            409: 'conflict',
            410: 'expired',
            429: 'rate_limited',
            503: 'unavailable',
          } as Record<number, string>
        )[status] ?? 'operation_failed'
      return { isError: true, structuredContent: { error: { code } }, content: [{ type: 'text', text: code }] }
    }
  }
}

function callerOf(ctx: McpRequestContext): McpCaller {
  const caller = ctx.authInfo?.extra?.[MCP_CALLER_KEY]
  // A missing caller is a wiring bug, never anonymous access.
  if (!caller) {
    throw new Error('MCP request reached the server factory without an authenticated caller')
  }
  return caller as McpCaller
}
