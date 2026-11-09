/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import passport from 'passport'
import type { Request } from 'express'
import type { AuthContextType } from '../common/interfaces/auth-context.interface'

/** Header that carries a delegation nonce on a request the MCP endpoint injects in-process. */
export const MCP_DELEGATION_HEADER = 'x-boxlite-mcp-delegation'

/** The passport strategy name `CombinedAuthGuard` tries first. */
export const MCP_DELEGATION_STRATEGY = 'mcp-delegation'

const NONCE_TTL_MS = 30_000

/** Nonce → caller. One map per process: a nonce never leaves this process and its own socket. */
const callers = new Map<string, { caller: AuthContextType; expiresAt: number }>()

function take(nonce: unknown): AuthContextType | undefined {
  if (typeof nonce !== 'string') return undefined
  const entry = callers.get(nonce)
  callers.delete(nonce)
  return entry && entry.expiresAt > Date.now() ? entry.caller : undefined
}

// Registered when this module loads, so every app that uses `CombinedAuthGuard`
// (which imports it) has the strategy, whether or not the MCP module is present.
passport.use(MCP_DELEGATION_STRATEGY, {
  name: MCP_DELEGATION_STRATEGY,
  authenticate(this: passport.StrategyCreated<passport.Strategy>, req: Request) {
    const caller = take(req.headers[MCP_DELEGATION_HEADER])
    // fail() without a challenge lets passport try the next strategy.
    if (caller) {
      this.success(caller)
    } else {
      this.fail()
    }
  },
} as passport.Strategy)

/**
 * Lets the MCP endpoint run a REST route as the caller it already authenticated,
 * without forwarding that caller's token: MCP forbids token passthrough, and an
 * MCP-audience token would fail the REST audience check anyway.
 *
 * The endpoint mints a single-use nonce bound to its caller and injects the REST
 * request in-process with it. The `mcp-delegation` strategy takes the nonce back
 * and admits the same caller object, so API-key scoping, organization resolution,
 * permission guards, throttles and audit run exactly as on a direct REST call.
 */
@Injectable()
export class McpDelegation {
  /** Binds `caller` to a fresh nonce for one injected request. */
  issue(caller: AuthContextType): string {
    const now = Date.now()
    for (const [nonce, entry] of callers) {
      if (entry.expiresAt <= now) callers.delete(nonce)
    }
    const nonce = randomBytes(32).toString('base64url')
    callers.set(nonce, { caller, expiresAt: now + NONCE_TTL_MS })
    return nonce
  }

  /** Consumes a nonce; a missing, reused or expired one yields nothing. */
  take(nonce: string): AuthContextType | undefined {
    return take(nonce)
  }
}
