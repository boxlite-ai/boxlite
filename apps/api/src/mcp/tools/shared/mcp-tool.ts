/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type Type, ValidationPipe } from '@nestjs/common'
import {
  McpServer,
  type CallToolResult,
  type ServerContext,
  type ToolAnnotations,
  type ToolCallback,
} from '@modelcontextprotocol/server'
import * as z from 'zod'
import { errorOutputSchema, errorResult, McpToolError } from '../../errors/tool-error'
import { serviceError } from '../../errors/service-error'
export { McpToolError } from '../../errors/tool-error'

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
      const value = await handler(args, context)
      const parsed = config.outputSchema.safeParse(value)
      if (!parsed.success) {
        throw new McpToolError('Tool operation failed', {
          source: 'mcp',
          operation: name,
          status: 500,
          code: 'internal_error',
          message: 'Tool operation failed',
        })
      }
      const result = parsed.data
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) {
      return errorResult(serviceError(error, name))
    }
  }
  // The SDK's conditional callback type also permits absent schemas; ours always has one.
  server.registerTool(
    name,
    { ...config, outputSchema: z.union([config.outputSchema, errorOutputSchema]) },
    callback as ToolCallback<I>,
  )
}

/** Reuse REST's transformations and nested validators after strict tool parsing. */
export async function validateMcpDto<T extends object>(metatype: Type<T>, value: unknown): Promise<T> {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
  return pipe.transform(value, { type: 'body', metatype })
}
