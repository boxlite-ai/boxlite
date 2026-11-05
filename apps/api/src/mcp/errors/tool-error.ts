/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import * as z from 'zod'

export const failureSchema = z.strictObject({
  source: z.enum(['service', 'runner', 'mcp']),
  operation: z.string(),
  code: z.string(),
  message: z.string().max(2048),
  status: z.number().int().min(100).max(599).optional(),
  type: z.string().optional(),
  retry_after_seconds: z.number().finite().nonnegative().optional(),
  outcome: z.literal('unknown').optional(),
})
export const errorOutputSchema = z.strictObject({ error: failureSchema })
export type ToolFailure = z.infer<typeof failureSchema>

/** Only deliberate public messages and projected metadata cross the tool boundary. */
export class McpToolError extends Error {
  constructor(
    message: string,
    readonly failure?: ToolFailure,
  ) {
    super(message)
  }
}

export function errorResult(error: ToolFailure) {
  const envelope = errorOutputSchema.parse({ error })
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: error.message },
      { type: 'text' as const, text: JSON.stringify(envelope) },
    ],
    structuredContent: envelope,
  }
}
