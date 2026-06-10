/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { Injectable, Logger } from '@nestjs/common'
import type { IncomingMessage } from 'http'
import type { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'
import { ApiKeyService } from '../api-key/api-key.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import type { Runner } from '../box/entities/runner.entity'

type RunnerUpgradeRequest = IncomingMessage & {
  __boxliteRunner?: Runner
  __boxliteRunnerBoxId?: string
}

// Matches /api/v1/boxes/<id>/executions/<id>/attach and the legacy
// /api/v1/<tenant>/boxes/<id>/executions/<id>/attach shape with optional query string.
// Capture group 1 is the box/box id.
const ATTACH_PATH = /^\/api\/v1\/(?:[^/]+\/)?boxes\/([^/]+)\/executions\/[^/]+\/attach(?:\?.*)?$/

/**
 * Singleton WebSocket proxy for `/attach` upgrades.
 *
 * Express middleware/guards don't run on Node's `upgrade` event, so the
 * NestJS controller `@Get(':boxId/executions/:execId/attach')` route never
 * fires for actual WS upgrade requests — it's HTTP-only and gets bypassed.
 * Main.ts registers `server.on('upgrade', wsProxy.upgrade)` and routes
 * matching paths through this service, which mirrors the API-key half of
 * CombinedAuthGuard inline, resolves the runner, and hands off to a
 * shared `createProxyMiddleware({ ws: true, ... })` instance.
 */
@Injectable()
export class BoxliteWsProxyService {
  private readonly logger = new Logger(BoxliteWsProxyService.name)
  private readonly proxy: RequestHandler

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly organizationUserService: OrganizationUserService,
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
  ) {
    this.proxy = createProxyMiddleware({
      ws: true,
      changeOrigin: true,
      // Drop the public `/api/v1/` or `/api/v1/<tenant>/` prefix; runner mounts routes at `/v1/...`.
      pathRewrite: (path: string, req: IncomingMessage) => {
        const runnerBoxId = (req as RunnerUpgradeRequest).__boxliteRunnerBoxId
        if (!runnerBoxId) {
          throw new Error('ws proxy: runner box id not resolved before upgrade — bug in caller')
        }
        return path.replace(/^\/api\/v1\/(?:[^/]+\/)?boxes\/[^/]+/, `/v1/boxes/${runnerBoxId}`)
      },
      // Target is resolved per-upgrade and stashed on the request before
      // delegating into the proxy.
      router: (req: IncomingMessage) => {
        const runner = (req as RunnerUpgradeRequest).__boxliteRunner
        if (!runner) {
          throw new Error('ws proxy: runner not resolved before upgrade — bug in caller')
        }
        return runner.apiUrl || (runner as Runner & { proxyUrl?: string }).proxyUrl || ''
      },
      on: {
        proxyReqWs: (proxyReq: { setHeader: (name: string, value: string) => void }, req: IncomingMessage) => {
          const runner = (req as RunnerUpgradeRequest).__boxliteRunner
          if (runner?.apiKey) {
            proxyReq.setHeader('Authorization', `Bearer ${runner.apiKey}`)
          }
        },
      },
    })
  }

  /** True when the request's URL is an `/attach` WS upgrade we should handle. */
  matchAttachPath(url: string | undefined): { boxId: string } | null {
    if (!url) return null
    const m = url.match(ATTACH_PATH)
    if (!m) return null
    return { boxId: m[1] }
  }

  /**
   * Resolve auth + box + runner, then hand the upgrade to the shared
   * proxy middleware. Closes the socket cleanly on any failure.
   */
  async upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const match = this.matchAttachPath(req.url)
    if (!match) {
      socket.destroy()
      return
    }

    const auth = await this.authenticate(req)
    if (!auth) {
      this.respondAndClose(socket, 401, 'Unauthorized')
      return
    }

    try {
      const box = await this.boxService.findOneByIdOrName(match.boxId, auth.organizationId)
      if (!box?.runnerId) {
        this.respondAndClose(socket, 404, 'Not Found')
        return
      }
      // Mirror legacy toolbox path — opening a WS attach is user activity,
      // so the autostop cron does not reap a session that's still connected.
      // Best-effort: do not fail the upgrade if this errors.
      this.boxService
        .updateLastActivityAt(box.id, new Date())
        .catch((err) => this.logger.warn(`updateLastActivityAt failed for ${box.id}: ${err}`))
      const runner = await this.runnerService.findOne(box.runnerId)
      if (!runner) {
        this.respondAndClose(socket, 404, 'Not Found')
        return
      }
      ;(req as RunnerUpgradeRequest).__boxliteRunner = runner
      ;(req as RunnerUpgradeRequest).__boxliteRunnerBoxId = box.id
      ;(
        this.proxy as unknown as {
          upgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
        }
      ).upgrade(req, socket, head)
    } catch (err) {
      this.logger.warn(`upgrade failed for ${req.url}: ${(err as Error).message}`)
      this.respondAndClose(socket, 404, 'Not Found')
    }
  }

  /**
   * Inline API-key authentication for WS upgrades. Mirrors what the HTTP path
   * gets from CombinedAuthGuard + OrganizationResourceActionGuard: the bearer
   * must be a non-expired API key whose user is still a member of the key's
   * organization. The membership check is critical — removing a user from an
   * org deletes the OrganizationUser row but does not cascade to ApiKey rows,
   * so without it a removed member's surviving key can still attach to
   * boxes in that org.
   *
   * JWT (the second strategy in CombinedAuthGuard) is unused here because
   * clients send an opaque, long-lived API key directly as the Bearer
   * token — there is no token-exchange step. If a JWT issuer is ever
   * enabled in the auth pipeline, extend this method to fall through to
   * `jwtVerify` after the API-key check fails.
   *
   * Unlike the HTTP path, this does not consult the Redis cache used by
   * ApiKeyStrategy / OrganizationAccessGuard. Upgrade frequency is low; if
   * upgrade latency becomes a concern, add caching as a follow-up.
   */
  private async authenticate(req: IncomingMessage): Promise<{ organizationId: string } | null> {
    const header = req.headers['authorization']
    const headerValue = Array.isArray(header) ? header[0] : header
    if (!headerValue || !/^bearer\s+/i.test(headerValue)) return null
    const token = headerValue.replace(/^bearer\s+/i, '').trim()
    if (!token) return null

    try {
      const apiKey = await this.apiKeyService.getApiKeyByValue(token)
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null

      const membership = await this.organizationUserService.findOne(apiKey.organizationId, apiKey.userId)
      if (!membership) return null

      return { organizationId: apiKey.organizationId }
    } catch {
      return null
    }
  }

  private respondAndClose(socket: Socket, status: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {
      // Socket may already be torn down — ignore.
    }
    socket.destroy()
  }
}
