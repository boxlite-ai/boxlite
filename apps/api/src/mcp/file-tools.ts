/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { McpToolAccess } from './mcp-tool-access'
import { completedOutput, McpToolError, mutationAnnotations, organizationInput, registerMcpTool } from './mcp-tool'
import { McpRunnerHttp, RunnerHttpError, RUNNER_ARCHIVE_LIMIT, type RunnerOperation } from './runner-http'
import { archiveTextContent, archiveTextFile, decodeBase64Archive, TEXT_FILE_LIMIT } from './file-content'

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'))
const scope = { ...organizationInput, box_id: path.max(256), path }
const archiveString = z.string().max(Math.ceil(RUNNER_ARCHIVE_LIMIT / 3) * 4)
const uploadFile = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('utf8'), content: z.string().max(TEXT_FILE_LIMIT) }),
  z.strictObject({
    format: z.literal('tar_base64'),
    archive_base64: archiveString,
    source_is_directory: z.boolean().optional(),
  }),
])
const downloadFile = z.discriminatedUnion('format', [
  z.strictObject({ format: z.literal('utf8'), content: z.string(), source_is_directory: z.literal(false) }),
  z.strictObject({
    format: z.literal('tar_base64'),
    archive_base64: archiveString,
    source_is_directory: z.boolean().nullable(),
  }),
])

@Injectable()
export class McpFileTools {
  constructor(
    private readonly access: McpToolAccess,
    private readonly runner: McpRunnerHttp,
  ) {}

  register(server: McpServer, caller: AuthContext): void {
    registerMcpTool(
      server,
      'upload_files',
      {
        description:
          'Upload UTF-8 single-file content or a base64 tar archive to the guest root filesystem. Limit: 60 KiB text or 64 KiB decoded tar; mounted filesystems are unsupported. Existing copy destination semantics apply.',
        inputSchema: z.strictObject({ ...scope, file: uploadFile }),
        outputSchema: completedOutput,
        annotations: { ...mutationAnnotations, destructiveHint: true },
      },
      async (args, context) => {
        const archive =
          args.file.format === 'utf8'
            ? archiveTextFile(args.path, args.file.content)
            : decodeBase64Archive(args.file.archive_base64)
        const sourceIsDirectory = args.file.format === 'utf8' ? false : args.file.source_is_directory
        await this.run(
          caller,
          args,
          { kind: 'upload', path: args.path, archive, sourceIsDirectory },
          context.mcpReq.signal,
        )
        return { completed: true as const }
      },
    )
    registerMcpTool(
      server,
      'download_files',
      {
        description:
          'Download a guest file as UTF-8 text or a base64 tar archive (64 KiB maximum). Text requires a confirmed single regular UTF-8 file within 60 KiB. Use tar_base64 for directories, binary files or older guests with unknown source shape; mounted filesystems are unsupported.',
        inputSchema: z.strictObject({ ...scope, format: z.enum(['utf8', 'tar_base64']).default('utf8') }),
        outputSchema: z.strictObject({ file: downloadFile }),
        annotations: mutationAnnotations,
      },
      async (args, context) => {
        const reply = await this.run(caller, args, { kind: 'download', path: args.path }, context.mcpReq.signal)
        if (args.format === 'tar_base64') {
          return {
            file: {
              format: 'tar_base64' as const,
              archive_base64: reply.body.toString('base64'),
              source_is_directory: reply.sourceIsDirectory ?? null,
            },
          }
        }
        return {
          file: {
            format: 'utf8' as const,
            content: await archiveTextContent(reply.body, reply.sourceIsDirectory),
            source_is_directory: false as const,
          },
        }
      },
    )
  }

  private async run(
    caller: AuthContext,
    input: { organization_id: string; box_id: string },
    operation: RunnerOperation,
    signal: AbortSignal,
  ) {
    const auth = await this.access.organization(
      caller,
      input.organization_id,
      [OrganizationResourcePermission.WRITE_BOXES],
      signal,
    )
    try {
      return await this.runner.execute(auth, input.box_id, operation, signal)
    } catch (error) {
      if (error instanceof RunnerHttpError) throw new McpToolError(error.message)
      throw error
    }
  }
}
