/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import type { Request } from 'express'

/**
 * Refuses MCP requests that carry an `Origin` header.
 *
 * The Streamable HTTP transport requires servers to validate `Origin` against
 * DNS rebinding. MCP hosts call this endpoint from their own servers or CLIs,
 * which send no `Origin`; a browser always sends one on a cross-origin POST.
 * Until a host is found that needs a browser origin, none is allowed.
 */
@Injectable()
export class McpOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    if (request.headers.origin !== undefined) {
      throw new ForbiddenException('Browser origins may not call the MCP endpoint')
    }
    return true
  }
}
