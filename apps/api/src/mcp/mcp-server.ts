/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
import { FastMCP, jsonSchemaAdapter, type JsonSchemaStandardSchema, type Tool, type ToolParameters } from 'fastmcp'
import { fromOpenAPI, type BundledOpenApiDocument } from 'fastmcp/openapi'
import { McpRest, McpRestError, type McpRequest } from './mcp-rest'

export const MCP_OPENAPI = Symbol('MCP_OPENAPI')
const names = {
  listBoxes: 'list_boxes',
  getBox: 'get_box',
  createBox: 'create_box',
  startBox: 'start_box',
  stopBox: 'stop_box',
  removeBox: 'delete_box',
}
const errorSchema = {
  type: 'object',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: {
      type: 'object',
      required: ['source', 'code', 'message'],
      properties: {
        source: { enum: ['rest', 'adapter'] },
        code: { type: 'string' },
        message: { type: 'string' },
        status: { type: 'integer' },
        details: {},
      },
    },
  },
}

// The only registration wrapper: generated tools retain their OpenAPI request
// mapping, while all calls share identity, cancellation, and error handling.
export class McpServer extends FastMCP {
  constructor(private readonly rest: McpRest) {
    super({ name: 'boxlite', version: '0.1.0', roots: { enabled: false }, ping: { enabled: false } })
  }

  override addTool<Params extends ToolParameters>(tool: Tool<Record<string, unknown> | undefined, Params>): void {
    const success = (tool.outputSchema as JsonSchemaStandardSchema | undefined)?.['~standard'].jsonSchema.output() ?? {
      type: 'object',
      required: ['status'],
      properties: { status: { const: 204 } },
    }
    const { $defs, $schema, ...shape } = success
    const readOnly = tool.name === 'list_boxes' || tool.name === 'get_box'
    super.addTool({
      ...tool,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: tool.name === 'create_box' },
      outputSchema: jsonSchemaAdapter({
        type: 'object',
        ...($schema ? { $schema } : {}),
        ...($defs ? { $defs } : {}),
        anyOf: [shape, errorSchema],
      }),
      execute: async (args, context) => {
        try {
          const request = context.session?.request as McpRequest | undefined
          if (!request?.user?.mcp) throw new McpRestError('missing_context', 'An authenticated MCP user is required')
          const boxId = (args as Record<string, unknown>)?.box_id
          if (boxId === '.' || boxId === '..')
            throw new McpRestError('invalid_path', 'Box ID cannot be a dot path segment')
          const result = await this.rest.run(request, context.signal, () => tool.execute(args, context))
          return result === '' ? { status: 204 } : result
        } catch (error) {
          return (
            error instanceof McpRestError ? error : new McpRestError('tool_failed', 'The tool could not complete')
          ).result()
        }
      },
    })
  }
}

export async function createMcpServer(document: BundledOpenApiDocument, rest: McpRest): Promise<McpServer> {
  const projection = structuredClone(document)
  projection.paths = {}
  const selected = new Set<string>()
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const methods = (['get', 'post', 'delete'] as const).flatMap((method) => {
      const operation = item[method]
      return operation?.operationId && Object.hasOwn(names, operation.operationId) ? [[method, operation] as const] : []
    })
    if (!methods.length) continue
    const parameters = (item.parameters ?? []).filter(
      (parameter) =>
        !('$ref' in parameter ? parameter.$ref === '#/components/parameters/prefix' : parameter.name === 'prefix'),
    )
    projection.paths[path.replace('/{prefix}', '')] = { ...Object.fromEntries(methods), parameters }
    for (const [, operation] of methods) {
      const id = (operation as { operationId: string }).operationId
      if (selected.has(id)) throw new Error(`Duplicate MCP operation: ${id}`)
      selected.add(id)
    }
  }
  if (selected.size !== Object.keys(names).length) throw new Error('Missing required MCP Box operation')
  const server = new McpServer(rest)
  await fromOpenAPI({
    spec: projection as Record<string, unknown>,
    server,
    baseUrl: 'http://mcp-rest.invalid',
    fetch: rest.fetch,
    mcpNames: names,
  })
  return server
}
