/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** A JSON Schema object, as OpenAPI 3.x and MCP tool inputs carry it. */
export type JsonSchema = Record<string, unknown>

/** The parts of an OpenAPI document the catalog reads. */
export interface OpenApiDocument {
  paths?: object
  components?: object
}

export interface McpOperationParam {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
}

/** One REST operation an MCP tool can reach, named by its OpenAPI `operationId`. */
export interface McpOperation {
  operationId: string
  method: string
  /** The route under the API's global prefix, with `{name}` path placeholders. */
  path: string
  summary: string
  description: string
  params: McpOperationParam[]
  body?: { kind: 'json' | 'binary'; contentType: string; required: boolean }
  /** A WebSocket upgrade (`101`) rather than a request/response call. */
  webSocket: boolean
  /** Tool input: path params, query and header params, and `body` or `body_base64`. */
  inputSchema: JsonSchema
}

/** Which document an operation comes from; earlier sources win a duplicated `operationId`. */
export interface McpCatalogSources {
  /** `openapi/box.openapi.yaml`, served under `/api/v1`. */
  box: OpenApiDocument
  /** `openapi/admin.openapi.yaml`, served under `/api/v1`. */
  admin: OpenApiDocument
  /** The Swagger document Nest builds for the dashboard controllers; paths include `/api`. */
  dashboard: OpenApiDocument
  /**
   * Whether a dashboard `operationId` may run as a delegated caller. Routes for
   * runners or the proxy, browser flows and JWT-only routes cannot, so they stay
   * out of the catalog rather than being listed and always failing.
   */
  delegable: (operationId: string) => boolean
  /** Whether this API serves the operation at all (see `servedOperations`). */
  served: (op: Pick<McpOperation, 'method' | 'path' | 'webSocket'>) => boolean
}

const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head']
/** Headers a tool argument may never set: credentials, routing and framing belong to the endpoint. */
const RESERVED_HEADERS = /^(authorization|cookie|host|content-(type|length)|x-forwarded-.*|x-boxlite-mcp-delegation)$/i

/** The REST operations MCP tools reach, built once at startup from the API's OpenAPI documents. */
export class McpCatalog {
  private readonly operations = new Map<string, McpOperation>()

  constructor(private readonly sources: McpCatalogSources) {
    // The v1 specs name the public contract, so their entry wins a shared `operationId`.
    this.addDocument(
      sources.box,
      (path) => `/api/v1${path.replace('/{prefix}', '')}`,
      () => true,
    )
    this.addDocument(
      sources.admin,
      (path) => `/api/v1${path.replace('/{prefix}', '')}`,
      () => true,
    )
    this.addDocument(sources.dashboard, (path) => path, sources.delegable)
  }

  get(operationId: string): McpOperation | undefined {
    return this.operations.get(operationId)
  }

  all(): McpOperation[] {
    return [...this.operations.values()]
  }

  /** Operations whose id, path or summary contains `search` (case-insensitive). */
  search(search?: string): McpOperation[] {
    const needle = search?.trim().toLowerCase()
    if (!needle) {
      return this.all()
    }
    return this.all().filter((op) =>
      [op.operationId, op.path, op.summary].some((field) => field.toLowerCase().includes(needle)),
    )
  }

  private addDocument(doc: OpenApiDocument, toRoute: (path: string) => string, admit: (id: string) => boolean): void {
    const resolve = refResolver(doc)
    for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, Record<string, unknown>>)) {
      const shared = asArray(item.parameters)
      for (const method of METHODS) {
        const operation = item[method] as Record<string, unknown> | undefined
        const operationId = operation?.operationId
        if (typeof operationId !== 'string' || this.operations.has(operationId) || !admit(operationId)) {
          continue
        }
        const op = toOperation(operationId, method, toRoute(path), shared, operation, resolve)
        if (this.sources.served(op)) {
          this.operations.set(operationId, op)
        }
      }
    }
  }
}

function toOperation(
  operationId: string,
  method: string,
  path: string,
  sharedParams: unknown[],
  operation: Record<string, unknown>,
  resolve: (value: unknown) => unknown,
): McpOperation {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const params: McpOperationParam[] = []
  for (const raw of [...sharedParams, ...asArray(operation.parameters)]) {
    const param = resolve(raw) as Record<string, unknown>
    const name = param.name as string
    const location = param.in as McpOperationParam['in']
    if (name === 'prefix' || !['path', 'query', 'header'].includes(location)) continue
    if (location === 'header' && RESERVED_HEADERS.test(name)) continue
    params.push({ name, in: location, required: param.required === true })
    properties[name] = { ...(param.schema as JsonSchema), description: param.description }
    if (param.required === true) required.push(name)
  }

  const body = requestBody(resolve(operation.requestBody) as Record<string, unknown> | undefined)
  if (body?.kind === 'json') {
    properties.body = body.schema
  } else if (body) {
    properties.body_base64 = { type: 'string', contentEncoding: 'base64', description: `Base64 ${body.contentType}` }
  }
  if (body?.required) required.push(body.kind === 'json' ? 'body' : 'body_base64')

  const responses = (operation.responses ?? {}) as Record<string, unknown>
  return {
    operationId,
    method,
    path,
    summary: (operation.summary as string) ?? '',
    description: (operation.description as string) ?? '',
    params,
    body: body && { kind: body.kind, contentType: body.contentType, required: body.required },
    webSocket: '101' in responses,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  }
}

function requestBody(body: Record<string, unknown> | undefined) {
  const content = (body?.content ?? {}) as Record<string, { schema?: JsonSchema }>
  const required = body?.required === true
  if (content['application/json']) {
    return {
      kind: 'json' as const,
      contentType: 'application/json',
      required,
      schema: content['application/json'].schema ?? {},
    }
  }
  const binary = Object.keys(content).find((type) => /octet-stream|x-tar/.test(type))
  return binary ? { kind: 'binary' as const, contentType: binary, required, schema: {} } : undefined
}

/** Inlines local `$ref`s; a reference back into its own chain becomes `{}` so cycles terminate. */
function refResolver(doc: OpenApiDocument): (value: unknown) => unknown {
  const lookup = (ref: string) =>
    ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc)
  const inline = (value: unknown, chain: Set<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => inline(item, chain))
    if (!value || typeof value !== 'object') return value
    const ref = (value as { $ref?: unknown }).$ref
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      return chain.has(ref) ? {} : inline(lookup(ref), new Set(chain).add(ref))
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inline(item, chain)]))
  }
  return (value) => inline(value, new Set())
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
