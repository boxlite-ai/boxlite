/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import type { IncomingMessage } from 'http'
import type { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'
import { ApiKeyService } from '../api-key/api-key.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { OrganizationService } from '../organization/services/organization.service'
import { Organization } from '../organization/entities/organization.entity'
import { UserService } from '../user/user.service'
import type { User } from '../user/user.entity'
import { SystemRole } from '../user/enums/system-role.enum'
import type { ApiKey } from '../api-key/api-key.entity'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import type { Runner } from '../box/entities/runner.entity'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { hasOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AttachTicketService } from '../box/services/attach-ticket.service'

type RunnerUpgradeRequest = IncomingMessage & {
  __boxliteRunner?: Runner
  __boxliteRunnerBoxId?: string
}

// Matches /api/v1/boxes/<id>/executions/<id>/attach and the
// /api/v1/<tenant>/boxes/<id>/executions/<id>/attach shape with optional query string.
// Named groups: `tenant` (optional org id / path prefix), `boxId` and `execId`.
const ATTACH_PATH =
  /^\/api\/v1\/(?:(?<tenant>[^/]+)\/)?boxes\/(?<boxId>[^/]+)\/executions\/(?<execId>[^/?]+)\/attach(?:\?.*)?$/

type AttachMatch = { boxId: string; execId: string; tenant?: string }
type AttachAuth = { organization: Organization; ticketBoxId?: string }

// `/attach` streams to an execution's stdin — interactive exec — so a WS upgrade
// needs the same box-write permission the HTTP exec routes now require.
const ATTACH_REQUIRED_PERMISSIONS = [OrganizationResourcePermission.WRITE_BOXES]

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
    private readonly organizationService: OrganizationService,
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
    private readonly autoResume: BoxAutoResumeService,
    private readonly userService: UserService,
    // Exported by AuthModule (already imported here). Resolves to `undefined`
    // when `skipConnections` is set, so the JWT path guards on it.
    @Inject(JwtStrategy) private readonly jwtStrategy: JwtStrategy | undefined,
    private readonly attachTickets: AttachTicketService,
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
   * Box, execution and optional tenant/org id when the URL is an `/attach` WS
   * upgrade. The tenant is the organization for JWT and ticket auth (an API key
   * carries its own org).
   */
  matchAttachPath(url: string | undefined): AttachMatch | null {
    if (!url) return null
    const groups = url.match(ATTACH_PATH)?.groups as AttachMatch | undefined
    if (!groups) return null
    return { boxId: groups.boxId, execId: groups.execId, tenant: groups.tenant }
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

    // Browsers cannot set `Authorization` on a WebSocket; they send a ticket.
    const auth = req.headers['authorization']
      ? await this.authenticate(req, match.tenant)
      : await this.authenticateTicket(req, match)
    if (!auth) {
      this.respondAndClose(socket, 401, 'Unauthorized')
      return
    }
    // The runner authenticates the proxy, not the ticket. Drop it before
    // anything below can log the URL or forward it to the runner.
    req.url = withoutTicket(req.url ?? '')

    try {
      const box = await this.boxService.findOneByIdOrName(match.boxId, auth.organization.id)
      if (!box?.runnerId) {
        this.respondAndClose(socket, 404, 'Not Found')
        return
      }
      // A ticket names the box it was issued for, by id; the URL may use a name.
      if (auth.ticketBoxId !== undefined && auth.ticketBoxId !== box.id) {
        this.respondAndClose(socket, 401, 'Unauthorized')
        return
      }
      if (box.autoResume) {
        await this.autoResume.ensureReady(box.id, auth.organization)
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
   * Inline authentication + authorization for WS upgrades, mirroring the API-key
   * + JWT halves of CombinedAuthGuard. Browsers, which cannot send the header,
   * use `authenticateTicket` instead. Beyond org membership it requires the
   * box-write permission: `/attach` streams to an execution's stdin (interactive
   * exec), so it is gated like the HTTP exec routes on `BoxliteProxyController`,
   * which now carry `write:boxes`. It applies the same policy as
   * OrganizationResourceActionGuard — a system admin and an interactive owner
   * without an API key are exempt — so the user's system role is resolved here
   * just as the HTTP strategies resolve it.
   * Never throws — any failure resolves to `null` (a 401), so the fire-and-forget
   * `upgrade` caller can't leak a hung socket.
   *
   * API key: the bearer must be a non-expired API key. A non-admin user must
   * still be a member of the key's organization — this check is critical, since
   * removing a user from an org deletes the OrganizationUser row but does not
   * cascade to ApiKey rows, so without it a removed member's surviving key could
   * still attach — and must carry write:boxes; a system admin is admitted without
   * either. The URL tenant is ignored (key is scoped).
   *
   * JWT (OIDC): when the bearer is not an API key, verify it via `JwtStrategy`
   * (same JWKS/issuer/audience as the HTTP path). A JWT carries no org, so the
   * organization is taken from the URL `{prefix}` (`urlTenant`); a request with
   * no tenant (or the legacy `default`) is rejected since the org is ambiguous
   * for a multi-org user. Authorization then applies identically to the API-key
   * path. `jwtStrategy` is absent when `skipConnections` is set.
   *
   * Unlike the HTTP path, this does not consult the Redis cache used by
   * ApiKeyStrategy / OrganizationAccessGuard. Upgrade frequency is low; if
   * upgrade latency becomes a concern, add caching as a follow-up.
   */
  private async authenticate(req: IncomingMessage, urlTenant?: string): Promise<AttachAuth | null> {
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
        // The system role comes from the key's user, as ApiKeyStrategy resolves it
        // on the HTTP path.
        const user = await this.userService.findOne(apiKey.userId)
        if (!user) return null
        if (!(await this.authorizeAttach(user, apiKey.organizationId, apiKey))) return null
        const organization = await this.organizationService.findOne(apiKey.organizationId)
        return organization ? { organization } : null
      }

      // 2. JWT (OIDC) — org comes from the URL tenant; authorized per authorizeAttach.
      if (!this.jwtStrategy) return null
      if (!urlTenant || urlTenant === 'default') return null
      const payload = await this.jwtStrategy.verifyToken(token)
      // Mirror JwtStrategy.validate's sub/uid handling (OKTA carries userId in `uid`).
      const claims = payload as { sub?: string; cid?: unknown; uid?: string }
      let userId = claims.sub
      if (claims.cid && claims.uid) userId = claims.uid
      if (!userId) return null

      const user = await this.userService.findOne(userId)
      if (!user) return null
      if (!(await this.authorizeAttach(user, urlTenant))) return null
      const organization = await this.organizationService.findOne(urlTenant)
      return organization ? { organization } : null
    } catch {
      // Any failure (invalid JWT signature, a DB error, …) → 401. This single
      // guard is why authenticate never throws — `upgrade` calls it before its
      // own try-block and main.ts runs `void upgrade(...)`, so an escaped throw
      // would leak a hung socket.
      return null
    }
  }

  /**
   * Authorize an attach upgrade with OrganizationResourceActionGuard's policy,
   * which the WS upgrade never reaches. A system admin is not organization-scoped
   * and is admitted without membership, exactly as OrganizationAccessGuard admits
   * it on the HTTP path. Everyone else must be a current member — removing a user
   * from an org drops the OrganizationUser row but not their API keys, so the check
   * is critical — and must carry write:boxes (an org owner without an API key is
   * exempt). Attach streams to an execution's stdin, i.e. interactive exec.
   */
  private async authorizeAttach(user: User, organizationId: string, apiKey?: ApiKey): Promise<boolean> {
    if (user.role === SystemRole.ADMIN) return true
    const membership = await this.organizationUserService.findOne(organizationId, user.id)
    if (!membership) return false
    return hasOrganizationResourcePermissions(
      { role: user.role, organizationUser: membership, apiKey },
      ATTACH_REQUIRED_PERMISSIONS,
    )
  }

  /**
   * Ticket auth for browsers (see `AttachTicketService`). The ticket is spent
   * on first use whatever the outcome, must name this execution and, when the
   * URL names one, the URL's organization (a prefix-less or `default` URL was
   * resolved to the grant's org when the ticket was issued). Its credential
   * must still pass `authorizeAttach`: the API key that bought it, which must
   * still exist and be unexpired, or else the user, as on the JWT path.
   * Never throws, for the same reason as `authenticate`.
   */
  private async authenticateTicket(req: IncomingMessage, match: AttachMatch): Promise<AttachAuth | null> {
    try {
      const ticket = new URL(req.url ?? '', 'http://attach.invalid').searchParams.get('ticket')
      if (!ticket) return null
      const grant = await this.attachTickets.consume(ticket)
      if (!grant || grant.execId !== match.execId) return null
      if (match.tenant && match.tenant !== 'default' && grant.organizationId !== match.tenant) return null
      const user = await this.userService.findOne(grant.userId)
      if (!user) return null
      let apiKey: ApiKey | undefined
      if (grant.apiKeyHash) {
        apiKey = await this.apiKeyService.getApiKeyByHash(grant.apiKeyHash)
        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null
        if (apiKey.organizationId !== grant.organizationId || apiKey.userId !== grant.userId) return null
      }
      if (!(await this.authorizeAttach(user, grant.organizationId, apiKey))) return null
      const organization = await this.organizationService.findOne(grant.organizationId)
      return organization ? { organization, ticketBoxId: grant.boxId } : null
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

function withoutTicket(url: string): string {
  const parsed = new URL(url, 'http://attach.invalid')
  parsed.searchParams.delete('ticket')
  return parsed.pathname + parsed.search
}
