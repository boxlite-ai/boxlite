/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../../../common/interfaces/auth-context.interface'
import { OrganizationResourcePermission } from '../../../organization/enums/organization-resource-permission.enum'
import { McpToolAccess } from '../shared/mcp-tool-access'
import {
  completedOutput,
  destructiveAnnotations,
  mutationAnnotations,
  organizationInput,
  McpToolError,
  registerMcpTool,
} from '../shared/mcp-tool'
import { McpRunnerHttp, type RunnerOperation } from '../../runner/runner-http'

const text = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'))
const boxInput = { ...organizationInput, box_id: text.min(1).max(256) }
const executionInput = {
  ...boxInput,
  execution_id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .refine((value) => value !== '.' && value !== '..'),
}
const executionOutput = z.object({ execution_id: z.string().min(1) })
const statusOutput = executionOutput.extend({
  status: z.enum(['running', 'completed', 'killed', 'timed_out']),
  exit_code: z.number().int().nullable().optional(),
  error_message: z.string().nullable().optional(),
})

@Injectable()
export class McpExecutionTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly runner: McpRunnerHttp,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'exec_box',
      {
        description:
          'Start an asynchronous command in a Box and return only its execution ID; do not repeat after an uncertain outcome.' +
          ' The complete serialized JSON request has a default 100 KiB (102400-byte) API limit, including JSON escaping and protocol envelope; field maxima may not fit together.' +
          ' For scripts or source exceeding inline limits, use upload_files within its 60 KiB UTF-8 text or 64 KiB complete decoded tar limit (including metadata), then execute the staged file with a short command/path.' +
          ' Stage in a confirmed existing guest root-filesystem directory outside mounts; /workspace is not guaranteed.',
        inputSchema: z.strictObject({
          ...boxInput,
          command: text
            .min(1)
            .describe(
              'Executable name or path: 1-4096 Unicode code points; NUL is not allowed. No shell is added automatically.',
            ),
          args: z
            .array(text)
            .max(256)
            .optional()
            .describe('Up to 256 arguments, each at most 4096 Unicode code points; NUL is not allowed.'),
          env: z
            .record(
              z
                .string()
                .min(1)
                .max(256)
                .regex(/^[^=\0]+$/),
              text,
            )
            .refine((env) => Object.keys(env).length <= 128)
            .optional()
            .describe(
              'Up to 128 environment entries. Keys: 1-256 Unicode code points, excluding "=" and NUL. Values: at most 4096 Unicode code points, excluding NUL.',
            ),
          timeout_seconds: z
            .number()
            .finite()
            .min(0.1)
            .optional()
            .describe('Optional execution timeout in seconds; at least 0.1 when supplied.'),
          working_dir: text
            .min(1)
            .optional()
            .describe('Guest working directory: 1-4096 Unicode code points; NUL is not allowed.'),
          tty: z.boolean().optional().describe('Allocate a pseudo-terminal when true; enables resize_execution.'),
        }),
        outputSchema: executionOutput,
        annotations: { ...destructiveAnnotations, openWorldHint: true },
      },
      async ({ organization_id, box_id, ...input }, context) => {
        const reply = await this.run(
          caller,
          { organization_id, box_id },
          { kind: 'exec', input },
          context.mcpReq.signal,
        )
        return parseReply(reply.body, executionOutput, true)
      },
    )
    registerMcpTool(
      server,
      'get_execution',
      {
        description:
          'Read execution state and exit information. This refreshes Box activity and may auto-resume; stdout and stderr are not included.',
        inputSchema: z.strictObject(executionInput),
        outputSchema: statusOutput,
        annotations: mutationAnnotations,
      },
      async (args, context) => {
        const reply = await this.run(
          caller,
          args,
          { kind: 'status', executionId: args.execution_id },
          context.mcpReq.signal,
        )
        return parseReply(reply.body, statusOutput, false)
      },
    )
    registerMcpTool(
      server,
      'kill_execution',
      {
        description: 'Kill an execution with SIGKILL and remove its Runner registry entry.',
        inputSchema: z.strictObject(executionInput),
        outputSchema: completedOutput,
        annotations: destructiveAnnotations,
      },
      async (args, context) => {
        await this.run(caller, args, { kind: 'kill', executionId: args.execution_id }, context.mcpReq.signal)
        return { completed: true as const }
      },
    )
    registerMcpTool(
      server,
      'signal_execution',
      {
        description: 'Deliver an allowed POSIX signal. Use kill_execution for SIGKILL.',
        inputSchema: z.strictObject({
          ...executionInput,
          signal: z.union([
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(6),
            z.literal(10),
            z.literal(12),
            z.literal(15),
            z.literal(28),
          ]),
        }),
        outputSchema: completedOutput,
        annotations: destructiveAnnotations,
      },
      async (args, context) => {
        await this.run(
          caller,
          args,
          { kind: 'signal', executionId: args.execution_id, signal: args.signal },
          context.mcpReq.signal,
        )
        return { completed: true as const }
      },
    )
    registerMcpTool(
      server,
      'resize_execution',
      {
        description: 'Resize the terminal of an execution started with tty enabled.',
        inputSchema: z.strictObject({
          ...executionInput,
          cols: z.number().int().min(1).max(0xffff_ffff),
          rows: z.number().int().min(1).max(0xffff_ffff),
        }),
        outputSchema: completedOutput,
        annotations: mutationAnnotations,
      },
      async (args, context) => {
        await this.run(
          caller,
          args,
          { kind: 'resize', executionId: args.execution_id, cols: args.cols, rows: args.rows },
          context.mcpReq.signal,
        )
        return { completed: true as const }
      },
    )
  }

  private async run(
    caller: AuthContext,
    scope: { organization_id: string; box_id: string },
    operation: RunnerOperation,
    signal: AbortSignal,
  ) {
    const permissions = operation.kind === 'status' ? [] : [OrganizationResourcePermission.WRITE_BOXES]
    const auth = await this.access.organization(caller, scope.organization_id, permissions, signal)
    return this.runner.execute(auth, scope.box_id, operation, signal)
  }
}

function parseReply<T extends z.ZodType>(body: Buffer, schema: T, effectful: boolean): z.output<T> {
  try {
    return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
  } catch {
    const message = effectful
      ? 'Invalid Runner response; the operation may have started. Its outcome is unknown.'
      : 'Invalid Runner execution response'
    throw new McpToolError(message, {
      source: 'runner',
      operation: effectful ? 'exec' : 'status',
      code: 'invalid_response',
      message,
      ...(effectful ? { outcome: 'unknown' as const } : {}),
    })
  }
}
