/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { MCP_DELEGATION_STRATEGY } from './mcp-delegation'

/**
 * Main authentication guard for the application.
 *
 * Strategies are tried in array order.
 * On first success, the rest are skipped. `mcp-delegation` goes first: it admits
 * only a request the MCP endpoint injected in-process (see `McpDelegation`) and
 * fails through to the token strategies for everything else.
 *
 * `handleRequest` is invoked once — either when a strategy succeeds or when all strategies fail.
 * It preserves the local-registration requirement; other failures become a generic 401.
 *
 * The generic reply is deliberate: a caller must not learn which strategy rejected it or why,
 * so a wrong key and an unknown key are indistinguishable.
 */
@Injectable()
export class CombinedAuthGuard extends AuthGuard([MCP_DELEGATION_STRATEGY, 'api-key', 'jwt']) {
  private readonly logger = new Logger(CombinedAuthGuard.name)

  handleRequest(err: any, user: any) {
    if (
      err instanceof ForbiddenException &&
      (err.getResponse() as { code?: string }).code === 'registration_required'
    ) {
      throw err
    }
    if (err || !user) {
      this.logger.debug('Authentication failed', { err, user })
      throw new UnauthorizedException('Invalid credentials')
    }

    return user
  }
}
