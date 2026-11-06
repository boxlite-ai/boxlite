/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  type INestApplication,
  Injectable,
} from '@nestjs/common'
import { json, type NextFunction, type Request, type RequestHandler, type Response, urlencoded } from 'express'

/**
 * JSON limit for `/api/mcp`: a tool call carries up to 8 MiB of binary as base64
 * (11,184,812 bytes) plus its JSON-RPC envelope. Other routes keep the 100 KB default.
 */
export const MCP_JSON_LIMIT_BYTES = 12 * 1024 * 1024

/** `/api/mcp`, matched as Express routes it: any case, with or without a trailing slash. */
const MCP_PATH = /^\/api\/mcp\/?$/i

/**
 * The API's body parsers, for an app created with `bodyParser: false`: the
 * defaults Nest would register (JSON, and extended form bodies), except on
 * `/api/mcp`, whose body {@link McpBodyGuard} reads once the caller is
 * authenticated. Call before `app.init()`.
 */
export function useApiBodyParsers(app: INestApplication): void {
  for (const parse of [json(), urlencoded({ extended: true })]) {
    app.use((req: Request, res: Response, next: NextFunction) =>
      MCP_PATH.test(req.path) ? next() : parse(req, res, next),
    )
  }
}

/**
 * Reads the `/api/mcp` JSON body after `McpAuthGuard`, so an unauthenticated
 * caller gets its counted 401 before any byte of the body is buffered or parsed.
 * Parse errors keep the statuses the global parsers give them: invalid JSON is
 * the 400 `BodyParserErrorModule` sends, and 413 or 415 stay as they are.
 */
@Injectable()
export class McpBodyGuard implements CanActivate {
  private readonly parse: RequestHandler = json({ limit: MCP_JSON_LIMIT_BYTES })

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp()
    await new Promise<void>((resolve, reject) =>
      // A body already read is skipped by the parser, so a second pass is a no-op.
      this.parse(http.getRequest<Request>(), http.getResponse<Response>(), (error?: unknown) =>
        error ? reject(httpError(error)) : resolve(),
      ),
    )
    return true
  }
}

function httpError(error: unknown): unknown {
  if (error instanceof SyntaxError && 'body' in error) return new BadRequestException('Invalid JSON in request body')
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new HttpException((error as Error).message, status)
  }
  return error
}
