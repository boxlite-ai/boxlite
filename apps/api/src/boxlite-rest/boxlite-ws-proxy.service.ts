/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import type { IncomingMessage } from 'http'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import type { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'
import { ApiKeyService } from '../api-key/api-key.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import type { Runner } from '../box/entities/runner.entity'

type RunnerUpgradeRequest = IncomingMessage & {
  __boxliteRunner?: Runner
  __boxliteRunnerBoxId?: string
}

// Matches WebSocket box data-plane routes:
// /api/v1/boxes/<id>/executions/<id>/attach,
// and the /api/v1/<tenant>/boxes/... shape with optional query string.
// Named groups: `tenant` (optional org id / path prefix) and `boxId`.
const BOX_WS_PATH =
  /^\/api\/v1\/(?:(?<tenant>[^/]+)\/)?boxes\/(?<boxId>[^/]+)\/executions\/[^/]+\/attach(?:\?.*)?$/

const NETWORK_CONNECT_PATH =
  /^\/api\/v1\/(?:(?<tenant>[^/]+)\/)?boxes\/(?<boxId>[^/]+)\/network\/tunnel(?:\?.*)?$/

/**
 * Singleton stream proxy for WebSocket and CONNECT upgrades.
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
    // Exported by AuthModule (already imported here). Resolves to `undefined`
    // when `skipConnections` is set, so the JWT path guards on it.
    @Inject(JwtStrategy) private readonly jwtStrategy: JwtStrategy | undefined,
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

  /**
   * Box id (+ optional tenant/org id) when the URL is a box WS upgrade.
   * The tenant is the organization for JWT auth (an API key carries its own org).
   */
  matchBoxWsPath(url: string | undefined): { boxId: string; tenant?: string } | null {
    if (!url) return null
    const groups = url.match(BOX_WS_PATH)?.groups as { boxId: string; tenant?: string } | undefined
    if (!groups) return null
    return { boxId: groups.boxId, tenant: groups.tenant }
  }

  matchNetworkConnectPath(url: string | undefined): { boxId: string; tenant?: string } | null {
    if (!url) return null
    const groups = url.match(NETWORK_CONNECT_PATH)?.groups as { boxId: string; tenant?: string } | undefined
    if (!groups) return null
    return { boxId: groups.boxId, tenant: groups.tenant }
  }

  matchAttachPath(url: string | undefined): { boxId: string; tenant?: string } | null {
    return this.matchBoxWsPath(url)
  }

  /**
   * Resolve auth + box + runner, then hand the upgrade to the shared
   * proxy middleware. Closes the socket cleanly on any failure.
   */
  async upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const match = this.matchBoxWsPath(req.url)
    if (!match) {
      socket.destroy()
      return
    }

    const auth = await this.authenticate(req, match.tenant)
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
   * Forward an SDK/CLI HTTP CONNECT to the runner without introducing a
   * WebSocket framing layer. Node's HTTP client owns the CONNECT handshake;
   * after the 200 response both sockets are plain byte streams.
   */
  async connect(req: IncomingMessage, socket: Socket): Promise<void> {
    const match = this.matchNetworkConnectPath(req.url)
    if (!match) {
      socket.destroy()
      return
    }

    const auth = await this.authenticate(req, match.tenant)
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
      const runner = await this.runnerService.findOne(box.runnerId)
      if (!runner) {
        this.respondAndClose(socket, 404, 'Not Found')
        return
      }

      const runnerUrl = new URL(runner.apiUrl || (runner as Runner & { proxyUrl?: string }).proxyUrl || '')
      const runnerPath = req.url!.replace(/^\/api\/v1\/(?:[^/]+\/)?boxes\/[^/]+/, `/v1/boxes/${box.id}`)
      const request = runnerUrl.protocol === 'https:' ? httpsRequest : httpRequest
      const upstream = request({
        protocol: runnerUrl.protocol,
        hostname: runnerUrl.hostname,
        port: runnerUrl.port || (runnerUrl.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT',
        path: runnerPath,
        headers: runner.apiKey ? { Authorization: `Bearer ${runner.apiKey}` } : undefined,
      })

      upstream.once('connect', (res, upstreamSocket, head) => {
        if (res.statusCode !== 200) {
          upstreamSocket.destroy()
          this.respondAndClose(socket, res.statusCode || 502, 'Bad Gateway')
          return
        }
        if (head.length > 0) socket.write(head)
        socket.pipe(upstreamSocket)
        upstreamSocket.pipe(socket)
        socket.once('close', () => upstreamSocket.destroy())
        upstreamSocket.once('close', () => socket.destroy())
      })
      upstream.once('error', (err) => {
        this.logger.warn(`CONNECT proxy failed for ${req.url}: ${(err as Error).message}`)
        socket.destroy()
      })
      upstream.end()
    } catch (err) {
      this.logger.warn(`CONNECT setup failed for ${req.url}: ${(err as Error).message}`)
      this.respondAndClose(socket, 502, 'Bad Gateway')
    }
  }

  /**
   * Inline authentication for WS upgrades, mirroring the API-key + JWT halves of
   * CombinedAuthGuard. Membership-only, like the HTTP exec/attach routes
   * (`BoxliteProxyController`), which carry no resource-permission decorator.
   * Never throws — any failure resolves to `null` (a 401), so the fire-and-forget
   * `upgrade` caller can't leak a hung socket.
   *
   * API key: the bearer must be a non-expired API key whose user is still a
   * member of the key's organization. The membership check is critical —
   * removing a user from an org deletes the OrganizationUser row but does not
   * cascade to ApiKey rows, so without it a removed member's surviving key could
   * still attach to boxes in that org. The URL tenant is ignored (key is scoped).
   *
   * JWT (OIDC): when the bearer is not an API key, verify it via `JwtStrategy`
   * (same JWKS/issuer/audience as the HTTP path). A JWT carries no org, so the
   * organization is taken from the URL `{prefix}` (`urlTenant`); a request with
   * no tenant (or the legacy `default`) is rejected since the org is ambiguous
   * for a multi-org user. Membership in that org is then required, identically to
   * the API-key path. `jwtStrategy` is absent when `skipConnections` is set.
   *
   * Unlike the HTTP path, this does not consult the Redis cache used by
   * ApiKeyStrategy / OrganizationAccessGuard. Upgrade frequency is low; if
   * upgrade latency becomes a concern, add caching as a follow-up.
   */
  private async authenticate(req: IncomingMessage, urlTenant?: string): Promise<{ organizationId: string } | null> {
    try {
      const header = req.headers['authorization']
      const headerValue = Array.isArray(header) ? header[0] : header
      if (!headerValue || !/^bearer\s+/i.test(headerValue)) return null
      const token = headerValue.replace(/^bearer\s+/i, '').trim()
      if (!token) return null

      // 1. API key — org comes from the key itself; the URL tenant is ignored, as
      //    before. A *throw* means "not an API key", so it is caught here to fall
      //    through to JWT rather than being rejected by the outer guard.
      const apiKey = await this.apiKeyService.getApiKeyByValue(token).catch(() => null)
      if (apiKey) {
        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null
        const membership = await this.organizationUserService.findOne(apiKey.organizationId, apiKey.userId)
        if (!membership) return null
        return { organizationId: apiKey.organizationId }
      }

      // 2. JWT (OIDC) — org comes from the URL tenant; membership required.
      if (!this.jwtStrategy) return null
      if (!urlTenant || urlTenant === 'default') return null
      const payload = await this.jwtStrategy.verifyToken(token)
      // Mirror JwtStrategy.validate's sub/uid handling (OKTA carries userId in `uid`).
      const claims = payload as { sub?: string; cid?: unknown; uid?: string }
      let userId = claims.sub
      if (claims.cid && claims.uid) userId = claims.uid
      if (!userId) return null

      const membership = await this.organizationUserService.findOne(urlTenant, userId)
      if (!membership) return null
      return { organizationId: urlTenant }
    } catch {
      // Any failure (invalid JWT signature, a DB error, …) → 401. This single
      // guard is why authenticate never throws — `upgrade` calls it before its
      // own try-block and main.ts runs `void upgrade(...)`, so an escaped throw
      // would leak a hung socket.
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
