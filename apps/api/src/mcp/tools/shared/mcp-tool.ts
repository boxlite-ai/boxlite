/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, type Type, ValidationPipe } from '@nestjs/common'
import {
  McpServer,
  type CallToolResult,
  type ServerContext,
  type ToolAnnotations,
  type ToolCallback,
} from '@modelcontextprotocol/server'
import * as z from 'zod'

/** Only deliberate, payload-free messages may cross the tool error boundary. */
export class McpToolError extends Error {}

export function assertMcpActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new McpToolError('Tool call cancelled before the operation started')
}

export const organizationInput = { organization_id: z.uuid() }
export const acceptedOutput = z.strictObject({ accepted: z.literal(true) })
export const completedOutput = z.strictObject({ completed: z.literal(true) })
export const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
export const mutationAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
export const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

export function registerMcpTool<I extends z.ZodType, O extends z.ZodType>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: I; outputSchema: O; annotations: ToolAnnotations },
  handler: (args: z.output<I>, context: ServerContext) => Promise<z.input<O>>,
): void {
  const callback = async (args: z.output<I>, context: ServerContext): Promise<CallToolResult> => {
    try {
      assertMcpActive(context.mcpReq.signal)
      const result = config.outputSchema.parse(await handler(args, context))
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: safeToolError(error) }] }
    }
  }
  // The SDK's conditional callback type also permits absent schemas; ours always has one.
  server.registerTool(name, config, callback as ToolCallback<I>)
}

export function safeToolError(error: unknown): string {
  if (error instanceof McpToolError) return error.message
  if (error instanceof HttpException) {
    const status = error.getStatus()
    if (status === 400 || status === 422) return 'Invalid tool request'
    if (status === 401 || status === 403) return 'Operation not permitted'
    if (status === 404) return 'Resource not found or not accessible'
    if (status === 409) return 'Resource conflicts with this operation'
    if (status === 408 || status === 504) return 'Operation timed out; its outcome may be uncertain'
    if (status === 501) return 'Operation is unavailable in this deployment'
    if (status === 503) return 'Service temporarily unavailable'
  }
  return 'Tool operation failed'
}

/** Reuse REST's transformations and nested validators after strict tool parsing. */
export async function validateMcpDto<T extends object>(metatype: Type<T>, value: unknown): Promise<T> {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
  return pipe.transform(value, { type: 'body', metatype })
}
