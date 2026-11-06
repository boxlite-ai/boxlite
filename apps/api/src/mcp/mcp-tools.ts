/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger, RequestMethod } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { MCP_STRATEGY, type McpStrategy } from '@rekog/mcp-nest'
import type { Request } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../auth/runner-auth.guard'
import { ProxyGuard } from '../box/guards/proxy.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { collectAttach } from './mcp-attach'
import { McpCatalog, type McpCatalogSources, type McpOperation } from './mcp-catalog'
import {
  McpArgumentError,
  McpDispatcher,
  McpResponseError,
  MCP_MAX_BINARY_BYTES,
  type McpRestResponse,
} from './mcp-dispatcher'
import { routeShape } from './mcp-routes'

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** `@ApiOperation` metadata key (`DECORATORS.API_OPERATION`, which @nestjs/swagger does not export). */
const API_OPERATION_METADATA = 'swagger/apiOperation'
const WAIT_DEFAULT_SECONDS = 60
const WAIT_MAX_SECONDS = 300

/** The box operations exposed as their own tools, with descriptions written for agents. */
const DIRECT_TOOLS: Record<string, string> = {
  createBox:
    'Create a box: an isolated Linux micro-VM started from a container image. Returns its id and state. startExecution starts it automatically.',
  listBoxes: 'List the boxes in your organization with their id, name, image and state.',
  getBox: 'Get one box by id or name: state, image, resources and network settings.',
  startBox: 'Start a stopped box.',
  stopBox: 'Stop a running box. Its disk is kept, and startBox resumes it.',
  removeBox: 'Delete a box and its disk. This cannot be undone.',
  startExecution:
    'Run a command in a box, starting the box if needed. With wait (the default) it returns stdout, stderr and exit_code; with wait=false it returns the execution_id to poll with getExecution.',
  getExecution: 'Get the status and exit code of an execution. Output comes from startExecution with wait.',
  uploadFiles: 'Upload files into a box as a base64-encoded tar archive in body_base64.',
  downloadFiles: 'Download a path from a box as a base64-encoded tar archive.',
}

/**
 * Registers the MCP tools: the {@link DIRECT_TOOLS} plus three meta-tools that
 * reach every catalog operation by `operationId` (the Stainless "dynamic tools"
 * pattern), so `tools/list` stays small however many routes the API has.
 */
@Injectable()
export class McpTools {
  private readonly logger = new Logger(McpTools.name)
  private catalog?: McpCatalog
  /** operationId → the permissions its route declares (`RequiredOrganizationResourcePermissions`). */
  private readonly permissions = new Map<string, string[]>()

  constructor(
    @Inject(MCP_STRATEGY) private readonly strategy: McpStrategy,
    private readonly dispatcher: McpDispatcher,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** The permissions the route of a catalog operation declares; empty when it needs only membership. */
  requiredPermissions(operationId: string): string[] {
    return this.permissions.get(operationId) ?? []
  }

  /** Builds the catalog once the app is initialized (so its routes are registered) and registers the tools. */
  register(sources: Omit<McpCatalogSources, 'delegable'>): McpCatalog {
    const delegable = this.delegableOperationIds()
    const catalog = new McpCatalog({ ...sources, delegable: (id) => delegable.has(id) })
    this.catalog = catalog
    const routes = this.routePermissions()
    for (const op of catalog.all()) {
      const shape = routeShape(op.path)
      // An `@All` route serves every verb, so it decides any operation on its path.
      this.permissions.set(op.operationId, routes.get(`${op.method} ${shape}`) ?? routes.get(`all ${shape}`) ?? [])
    }
    for (const [operationId, description] of Object.entries(DIRECT_TOOLS)) {
      const op = catalog.get(operationId)
      if (!op) {
        throw new Error(`MCP direct tool ${operationId} is missing from the OpenAPI catalog`)
      }
      this.strategy.registerTool({
        name: operationId,
        description,
        parameters: operationId === 'startExecution' ? withWait(op.inputSchema) : op.inputSchema,
        handler: (args, _ctx, request: Request) => this.invoke(op, args, request),
      })
    }
    this.registerMetaTools(catalog)
    this.logger.log(`MCP catalog: ${catalog.all().length} operations`)
    return catalog
  }

  private registerMetaTools(catalog: McpCatalog): void {
    this.strategy.registerTool({
      name: 'list_api_endpoints',
      description:
        'List BoxLite API operations (operationId, method, path, summary), optionally filtered by a search string. Use get_api_endpoint_schema, then invoke_api_endpoint.',
      parameters: { type: 'object', properties: { search: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler: (args) =>
        jsonResult({
          endpoints: catalog
            .search(args.search as string | undefined)
            .map(({ operationId, method, path, summary }) => ({ operationId, method, path, summary })),
        }),
    })
    this.strategy.registerTool({
      name: 'get_api_endpoint_schema',
      description: 'Get the description and argument JSON Schema of one BoxLite API operation.',
      parameters: {
        type: 'object',
        properties: { operationId: { type: 'string' } },
        required: ['operationId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      handler: (args) => {
        const op = catalog.get(args.operationId as string)
        if (!op) return errorResult(`Unknown operationId: ${args.operationId}`)
        const { operationId, method, path, summary, description, inputSchema } = op
        return jsonResult({ operationId, method, path, summary, description, inputSchema })
      },
    })
    this.strategy.registerTool({
      name: 'invoke_api_endpoint',
      description:
        'Call one BoxLite API operation by operationId with arguments matching its get_api_endpoint_schema schema.',
      parameters: {
        type: 'object',
        properties: { operationId: { type: 'string' }, arguments: { type: 'object' } },
        required: ['operationId'],
        additionalProperties: false,
      },
      handler: (args, _ctx, request: Request) => {
        const op = catalog.get(args.operationId as string)
        if (!op) return errorResult(`Unknown operationId: ${args.operationId}`)
        return this.invoke(op, (args.arguments as Record<string, unknown>) ?? {}, request)
      },
    })
  }

  private async invoke(op: McpOperation, args: Record<string, unknown>, request: Request): Promise<ToolResult> {
    try {
      if (op.webSocket) {
        return op.operationId === 'attachExecution'
          ? await this.attach(String(args.box_id), String(args.exec_id), args, request)
          : errorResult(`${op.operationId} is not served by this API; run a command with startExecution instead`)
      }
      const { wait, wait_timeout_seconds, ...rest } = args
      const response = await this.dispatcher.call(op, rest, request)
      if (op.operationId === 'startExecution' && wait !== false && response.status < 300) {
        const executionId = (response.json as { execution_id?: string })?.execution_id
        if (executionId) {
          return await this.attach(String(rest.box_id), executionId, { wait_timeout_seconds }, request)
        }
      }
      return restResult(response)
    } catch (error) {
      if (error instanceof McpArgumentError || error instanceof McpResponseError) return errorResult(error.message)
      throw error
    }
  }

  /** Reads an execution's output over its attach WebSocket, authenticated by a one-time ticket. */
  private async attach(boxId: string, executionId: string, args: Record<string, unknown>, request: Request) {
    const ticketOp = this.catalog?.get('createAttachTicket')
    if (!ticketOp) return errorResult('Attach tickets are unavailable')
    const ticket = await this.dispatcher.call(ticketOp, { boxIdOrName: boxId, body: { executionId } }, request)
    const value = (ticket.json as { ticket?: string })?.ticket
    if (ticket.status >= 300 || !value) return restResult(ticket)
    // Over the dispatcher's private socket, so no TLS name or port is involved.
    const url = await this.dispatcher.webSocketUrl(
      `/api/v1/boxes/${encodeURIComponent(boxId)}` +
        `/executions/${encodeURIComponent(executionId)}/attach?stdin=0&ticket=${encodeURIComponent(value)}`,
    )
    const seconds = Math.min(Number(args.wait_timeout_seconds) || WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS)
    const result = await collectAttach(url, executionId, seconds * 1000)
    if (result.error) {
      // The socket closed without an exit frame, as it can when the process ended
      // before the attach: the execution's status still has the exit code.
      const statusOp = this.catalog?.get('getExecution')
      const status =
        statusOp && (await this.dispatcher.call(statusOp, { box_id: boxId, exec_id: executionId }, request))
      const info = status?.json as { status?: string; exit_code?: number | null } | undefined
      if (info?.status && info.status !== 'running') {
        return jsonResult({ ...result, error: undefined, complete: true, exit_code: info.exit_code ?? null })
      }
      return { ...jsonResult(result as unknown as Record<string, unknown>), isError: true }
    }
    return jsonResult(result as unknown as Record<string, unknown>)
  }

  /** `method /api/path` of every controller route → the permissions it declares. */
  private routePermissions(): Map<string, string[]> {
    const routes = new Map<string, string[]>()
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined
      if (!controller || !wrapper.instance) continue
      const prototype = Object.getPrototypeOf(wrapper.instance)
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method]
        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined
        if (verb === undefined) continue
        const permissions =
          this.reflector.get(RequiredOrganizationResourcePermissions, handler) ??
          this.reflector.get(RequiredOrganizationResourcePermissions, controller) ??
          []
        for (const base of [Reflect.getMetadata(PATH_METADATA, controller) ?? ''].flat()) {
          for (const path of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat()) {
            routes.set(`${RequestMethod[verb].toLowerCase()} ${routeShape(`api/${base}/${path}`)}`, permissions)
          }
        }
      }
    }
    return routes
  }

  /**
   * Dashboard `operationId`s a delegated caller can run: routes behind
   * `CombinedAuthGuard` that no runner or proxy guard also requires. JWT-only,
   * anonymous and machine routes are left out.
   */
  private delegableOperationIds(): Set<string> {
    const ids = new Set<string>()
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined
      if (!controller || !wrapper.instance) continue
      const classGuards = Reflect.getMetadata(GUARDS_METADATA, controller) ?? []
      const prototype = Object.getPrototypeOf(wrapper.instance)
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method]
        const guards: unknown[] = [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])]
        const has = (guard: unknown) => guards.some((g) => g === guard || (g as object)?.constructor === guard)
        if (has(CombinedAuthGuard) && !has(RunnerAuthGuard) && !has(ProxyGuard)) {
          const explicit = Reflect.getMetadata(API_OPERATION_METADATA, handler)?.operationId
          ids.add(explicit ?? `${controller.name}_${method}`)
        }
      }
    }
    return ids
  }
}

function withWait(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  return {
    ...schema,
    properties: {
      ...properties,
      wait: { type: 'boolean', default: true, description: 'Wait for the command to exit and return its output' },
      wait_timeout_seconds: {
        type: 'integer',
        minimum: 1,
        maximum: WAIT_MAX_SECONDS,
        default: WAIT_DEFAULT_SECONDS,
        description: 'How long to wait; on timeout the result has complete=false and partial output',
      },
    },
  }
}

function restResult(response: McpRestResponse): ToolResult {
  const isError = response.status >= 400
  if (response.json !== undefined) {
    const structured =
      response.json && typeof response.json === 'object' && !Array.isArray(response.json)
        ? (response.json as Record<string, unknown>)
        : { items: response.json }
    return { content: [{ type: 'text', text: JSON.stringify(response.json) }], structuredContent: structured, isError }
  }
  if (response.body.length === 0) {
    return { content: [{ type: 'text', text: `HTTP ${response.status}` }], isError }
  }
  if (/^text\//.test(response.contentType)) {
    return { content: [{ type: 'text', text: response.body.toString('utf8') }], isError }
  }
  if (response.body.length > MCP_MAX_BINARY_BYTES) {
    return errorResult(`Response of ${response.body.length} bytes exceeds the ${MCP_MAX_BINARY_BYTES}-byte limit`)
  }
  return jsonResult({ content_type: response.contentType, base64: response.body.toString('base64') }, isError)
}

function jsonResult(value: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
