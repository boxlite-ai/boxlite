/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Agent, ClientRequest, IncomingMessage } from 'http'
import type { Socket } from 'net'
import { createProxyMiddleware, errorResponsePlugin, type RequestHandler } from 'http-proxy-middleware'
import { ApiKeyStrategy, type ApiKeyUserCache } from '../auth/api-key.strategy'
import { JwtStrategy, jwtUserId } from '../auth/jwt.strategy'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { OrganizationService } from '../organization/services/organization.service'
import { Organization } from '../organization/entities/organization.entity'
import { User } from '../user/user.entity'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { OrganizationAccessCache } from '../organization/services/organization-access-cache.service'
import { RunnerProxyAgents } from './runner-proxy-agents'
import { SystemRole } from '../user/enums/system-role.enum'
import type { ApiKey } from '../api-key/api-key.entity'
import { BoxService } from '../box/services/box.service'
import { RunnerService, type RunnerProxyTarget } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { hasOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AttachTicketService } from '../box/services/attach-ticket.service'
import { AuditService } from '../audit/services/audit.service'
import { AttachAuditSession } from './attach-audit-session'
import { propagation } from '@opentelemetry/api'
import { startTimedOperation, TimedOperation } from '../common/decorators/otel.decorator'

type RunnerUpgradeRequest = IncomingMessage & {
  __boxliteRunner?: RunnerProxyTarget
  __boxliteRunnerBoxId?: string
  __boxliteAttachAudit?: AttachAuditSession
  __boxliteExecutionId?: string
  __boxliteWsRoot?: TimedOperation
  __boxliteWsHandshake?: TimedOperation
  __boxliteWsHandshakeSucceeded?: boolean
}

// Matches /api/v1/boxes/<id>/executions/<id>/attach and the
// /api/v1/<tenant>/boxes/<id>/executions/<id>/attach shape with optional query string.
// Named groups: `tenant` (optional org id / path prefix), `boxId` and `execId`.
const ATTACH_PATH =
  /^\/api\/v1\/(?:(?<tenant>[^/]+)\/)?boxes\/(?<boxId>[^/]+)\/executions\/(?<execId>[^/?]+)\/attach(?:\?.*)?$/

type AttachMatch = { boxId: string; execId: string; tenant?: string }
type AttachAuth = { organization: Organization; user: User; ticketBoxId?: string }

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
 * matching paths through this service, which applies CombinedAuthGuard's user
 * credential policy, resolves the runner, and hands off to a shared
 * `createProxyMiddleware({ ws: true, ... })` instance per target protocol.
 */
@Injectable()
export class BoxliteWsProxyService {
  private readonly logger = new Logger(BoxliteWsProxyService.name)
  private readonly proxy: RequestHandler
  private tlsProxy?: RequestHandler
  private readonly upgrades = new WeakMap<Socket, RunnerUpgradeRequest>()
  @InjectRedis() private readonly redis: Redis
  private accessCache?: OrganizationAccessCache

  constructor(
    private readonly apiKeyStrategy: ApiKeyStrategy,
    private readonly organizationUserService: OrganizationUserService,
    private readonly organizationService: OrganizationService,
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
    private readonly autoResume: BoxAutoResumeService,
    // Exported by AuthModule (already imported here). Resolves to `undefined`
    // when `skipConnections` is set, so the JWT path guards on it.
    @Inject(JwtStrategy) private readonly jwtStrategy: JwtStrategy | undefined,
    private readonly attachTickets: AttachTicketService,
    private readonly auditService: AuditService,
    private readonly proxyAgents: RunnerProxyAgents,
  ) {
    this.proxy = this.createProxy(this.proxyAgents.http)
  }

  private createProxy(agent: Agent): RequestHandler {
    return createProxyMiddleware({
      agent,
      secure: false,
      ws: true,
      changeOrigin: true,
      plugins: [errorResponsePlugin],
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
        return runner.apiUrl || runner.proxyUrl || ''
      },
      on: {
        proxyReqWs: (proxyReq: ClientRequest, req: IncomingMessage) => {
          const upgradeReq = req as RunnerUpgradeRequest
          const runner = upgradeReq.__boxliteRunner
          if (runner?.apiKey) {
            proxyReq.setHeader('Authorization', `Bearer ${runner.apiKey}`)
          }
          const root = upgradeReq.__boxliteWsRoot
          if (root) {
            upgradeReq.__boxliteWsHandshakeSucceeded = false
            const target = runner?.apiUrl || runner?.proxyUrl || ''
            const protocol = target.toLowerCase().startsWith('https:') ? 'https' : 'http'
            const handshakeMetrics: Record<string, string> = {
              component: BoxliteWsProxyService.name,
              method: 'upgrade',
              protocol,
              reused_socket: 'unknown',
            }
            const handshake = startTimedOperation(
              'box.exec.ws_handshake',
              {
                component: BoxliteWsProxyService.name,
                method: 'upgrade',
                box_id: upgradeReq.__boxliteRunnerBoxId ?? '',
                execution_id: upgradeReq.__boxliteExecutionId ?? '',
                'runner.protocol': protocol,
              },
              handshakeMetrics,
              root.ctx,
            )
            upgradeReq.__boxliteWsHandshake = handshake
            const recordSocket = () => {
              const reused = proxyReq.reusedSocket === true
              handshakeMetrics.reused_socket = String(reused)
              handshake.setAttributes({ 'runner.reused_socket': reused })
            }
            proxyReq.once('socket', recordSocket)
            if (proxyReq.socket) recordSocket()
            proxyReq.once('upgrade', (_proxyRes, proxySocket) => this.upgrades.set(proxySocket, upgradeReq))
            this.bindHandshakeDeadline(proxyReq, upgradeReq)
            propagation.inject(handshake.ctx, {}, { set: (_carrier, key, value) => proxyReq.setHeader(key, value) })
          }
          upgradeReq.__boxliteAttachAudit?.bind(proxyReq)
        },
        open: (proxySocket) => {
          const upgradeReq = this.upgrades.get(proxySocket)
          if (upgradeReq) upgradeReq.__boxliteWsHandshakeSucceeded = true
          upgradeReq?.__boxliteWsHandshake?.finish()
        },
        close: (_proxyRes, proxySocket) => {
          const upgradeReq = this.upgrades.get(proxySocket)
          if (!upgradeReq) return
          upgradeReq.__boxliteWsHandshake?.finish('error', new Error('runner socket closed during handshake'))
          upgradeReq.__boxliteWsRoot?.finish(
            upgradeReq.__boxliteWsHandshakeSucceeded === false ? 'error' : 'success',
            upgradeReq.__boxliteWsHandshakeSucceeded === false
              ? new Error('runner socket closed before the upgrade completed')
              : undefined,
          )
        },
        error: (error, req) => {
          const upgradeReq = req as RunnerUpgradeRequest
          upgradeReq.__boxliteWsHandshake?.finish('error', error)
          upgradeReq.__boxliteWsRoot?.finish('error', error)
        },
      },
    })
  }

  private bindHandshakeDeadline(proxyReq: ClientRequest, upgradeReq: RunnerUpgradeRequest): void {
    const clear = () => {
      clearTimeout(timer)
      proxyReq.off('upgrade', clear)
      proxyReq.off('response', clear)
      proxyReq.off('error', clear)
      proxyReq.off('close', clear)
    }
    const timer = setTimeout(() => {
      clear()
      const error = new Error('runner websocket handshake timed out')
      upgradeReq.__boxliteWsHandshake?.finish('timeout', error)
      upgradeReq.__boxliteWsRoot?.finish('timeout', error)
      proxyReq.destroy(error)
    }, 10_000)
    timer.unref()
    proxyReq.once('upgrade', clear)
    proxyReq.once('response', clear)
    proxyReq.once('error', clear)
    proxyReq.once('close', clear)
  }

  private proxyFor(target: string): RequestHandler {
    if (!target.toLowerCase().startsWith('https:')) return this.proxy
    this.tlsProxy ??= this.createProxy(this.proxyAgents.https)
    return this.tlsProxy
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
    const upgradeReq = req as RunnerUpgradeRequest
    const root = startTimedOperation(
      'box.exec.ws',
      {
        component: BoxliteWsProxyService.name,
        method: 'upgrade',
        box_id: match.boxId,
        execution_id: match.execId,
      },
      { component: BoxliteWsProxyService.name, method: 'upgrade' },
    )
    upgradeReq.__boxliteExecutionId = match.execId
    upgradeReq.__boxliteWsRoot = root
    let socketError: unknown
    socket.once('error', (error) => {
      socketError = error
      upgradeReq.__boxliteWsHandshake?.finish('error', error)
      root.finish('error', error)
    })
    socket.once('close', () => {
      upgradeReq.__boxliteWsHandshake?.finish('error', new Error('client socket closed during handshake'))
      const upgradeFailed = upgradeReq.__boxliteWsHandshakeSucceeded === false
      root.finish(
        socketError !== undefined || upgradeFailed ? 'error' : 'success',
        socketError ?? (upgradeFailed ? new Error('client socket closed before the upgrade completed') : undefined),
      )
    })

    const authentication = startTimedOperation(
      'box.exec.ws_auth',
      { component: BoxliteWsProxyService.name, method: 'upgrade' },
      { component: BoxliteWsProxyService.name, method: 'upgrade' },
      root.ctx,
    )
    // Browsers cannot set `Authorization` on a WebSocket; they send a ticket.
    const auth = req.headers['authorization']
      ? await this.authenticate(req, match.tenant)
      : await this.authenticateTicket(req, match)
    if (!auth) {
      authentication.finish('error', new Error('unauthorized'))
      root.finish('error', new Error('unauthorized'))
      this.respondAndClose(socket, 401, 'Unauthorized')
      return
    }
    authentication.finish()
    // The runner authenticates the proxy, not the ticket. Drop it before
    // anything below can log the URL or forward it to the runner.
    req.url = withoutTicket(req.url ?? '')

    const lookup = startTimedOperation(
      'box.exec.ws_lookup',
      { component: BoxliteWsProxyService.name, method: 'upgrade', execution_id: match.execId },
      { component: BoxliteWsProxyService.name, method: 'upgrade' },
      root.ctx,
    )
    try {
      const box = await this.boxService.findOneByIdOrName(match.boxId, auth.organization.id)
      if (!box?.runnerId) {
        lookup.finish('error', new Error('box or runner not found'))
        root.finish('error', new Error('box or runner not found'))
        this.respondAndClose(socket, 404, 'Not Found')
        return
      }
      root.setAttributes({ box_id: box.id })
      lookup.setAttributes({ box_id: box.id })
      // A ticket names the box it was issued for, by id; the URL may use a name.
      if (auth.ticketBoxId !== undefined && auth.ticketBoxId !== box.id) {
        lookup.finish('error', new Error('ticket box mismatch'))
        root.finish('error', new Error('ticket box mismatch'))
        this.respondAndClose(socket, 401, 'Unauthorized')
        return
      }
      if (box.autoResume) {
        await this.autoResume.ensureReady(box.id, auth.organization)
      }
      // Opening a WS attach is user activity,
      // so the autostop cron does not reap a session that's still connected.
      // Best-effort: do not fail the upgrade if this errors.
      this.boxService
        .updateLastActivityAt(box.id, new Date())
        .catch((err) => this.logger.warn(`updateLastActivityAt failed for ${box.id}: ${err}`))
      const runner = await this.runnerService.findProxyTarget(box.runnerId)
      if (!runner) {
        lookup.finish('error', new Error('runner not found'))
        root.finish('error', new Error('runner not found'))
        this.respondAndClose(socket, 404, 'Not Found')
        return
      }
      lookup.finish()
      upgradeReq.__boxliteRunner = runner
      upgradeReq.__boxliteRunnerBoxId = box.id
      const session = AttachAuditSession.start(
        this.auditService,
        socket,
        {
          actorId: auth.user.id,
          actorEmail: auth.user.email ?? '',
          organizationId: auth.organization.id,
          targetId: box.id,
        },
        match.execId,
      )
      if (!session) {
        root.finish()
        return
      }
      upgradeReq.__boxliteAttachAudit = session
      const proxy = this.proxyFor(runner.apiUrl || runner.proxyUrl || '')
      ;(
        proxy as unknown as {
          upgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
        }
      ).upgrade(req, socket, head)
    } catch (err) {
      lookup.finish('error', err)
      root.finish('error', err)
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
   * still be a member of the key's organization and carry write:boxes; a system
   * admin is admitted without either. Member removal and user deletion revoke
   * the affected keys; the membership check also rejects keys left behind by
   * older deletion paths. The URL tenant is ignored (key is scoped).
   *
   * JWT (OIDC): when the bearer is not an API key, verify it via `JwtStrategy`
   * (same JWKS/issuer/audience as the HTTP path). A JWT carries no org, so the
   * organization is taken from the URL `{prefix}` (`urlTenant`); a request with
   * no tenant (or the legacy `default`) is rejected since the org is ambiguous
   * for a multi-org user. Authorization then applies identically to the API-key
   * path. `jwtStrategy` is absent when `skipConnections` is set.
   *
   * API-key and user reads share ApiKeyStrategy's Redis entries without its
   * last-used write or machine-credential fallbacks. Organization and membership
   * reads share OrganizationAccessCache's TTL, invalidation and generation checks.
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
      const apiKey = await this.apiKeyStrategy.findApiKey(token).catch(() => null)
      if (apiKey) {
        const user = await this.findUser(apiKey.userId)
        if (!user) return null
        const organization = await this.resolveAttachOrganization(user, apiKey.organizationId, apiKey)
        return organization ? { organization, user } : null
      }

      // 2. JWT (OIDC) — org comes from the URL tenant; authorized per resolveAttachOrganization.
      if (!this.jwtStrategy) return null
      if (!urlTenant || urlTenant === 'default') return null
      const userId = jwtUserId(await this.jwtStrategy.verifyToken(token))
      if (!userId) return null

      const user = await this.findUser(userId)
      if (!user) return null
      const organization = await this.resolveAttachOrganization(user, urlTenant)
      return organization ? { organization, user } : null
    } catch {
      // Any failure (invalid JWT signature, a DB error, …) → 401. This single
      // guard is why authenticate never throws — `upgrade` calls it before its
      // own try-block and main.ts runs `void upgrade(...)`, so an escaped throw
      // would leak a hung socket.
      return null
    }
  }

  private async findUser(userId: string): Promise<User | null> {
    const cached = await this.apiKeyStrategy.findUser(userId)
    return cached ? this.attachUser(cached) : null
  }

  private attachUser(cached: ApiKeyUserCache): User {
    return Object.assign(Object.create(User.prototype), {
      id: cached.userId,
      role: cached.role,
      email: cached.email,
    }) as User
  }

  /**
   * Authorize an attach upgrade with OrganizationResourceActionGuard's policy,
   * which the WS upgrade never reaches. A system admin is not organization-scoped
   * and is admitted without membership, exactly as OrganizationAccessGuard admits
   * it on the HTTP path. Everyone else must be a current member and must carry
   * write:boxes (an org owner without an API key is exempt). Attach streams to an
   * execution's stdin, i.e. interactive exec.
   */
  private async resolveAttachOrganization(
    user: User,
    organizationId: string,
    apiKey?: ApiKey,
  ): Promise<Organization | null> {
    this.accessCache ??= new OrganizationAccessCache(this.redis)
    const organization = this.accessCache.getOrganization(organizationId, () =>
      this.organizationService.findOne(organizationId),
    )
    if (user.role === SystemRole.ADMIN) return organization

    const [resolvedOrganization, membership] = await Promise.all([
      organization,
      this.accessCache.getOrganizationUser(organizationId, user.id, () =>
        this.organizationUserService.findOne(organizationId, user.id),
      ),
    ])
    if (!resolvedOrganization || !membership) return null
    return hasOrganizationResourcePermissions(
      { role: user.role, organizationUser: membership, apiKey },
      ATTACH_REQUIRED_PERMISSIONS,
    )
      ? resolvedOrganization
      : null
  }

  /**
   * Ticket auth for browsers (see `AttachTicketService`). The ticket is spent
   * on first use whatever the outcome, must name this execution and, when the
   * URL names one, the URL's organization (a prefix-less or `default` URL was
   * resolved to the grant's org when the ticket was issued). Its credential
   * must still pass `resolveAttachOrganization`: the API key that bought it, which must
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
      const user = await this.findUser(grant.userId)
      if (!user) return null
      let apiKey: ApiKey | undefined
      if (grant.apiKeyHash) {
        apiKey = await this.apiKeyStrategy.findApiKeyByHash(grant.apiKeyHash)
        if (apiKey.organizationId !== grant.organizationId || apiKey.userId !== grant.userId) return null
      }
      const organization = await this.resolveAttachOrganization(user, grant.organizationId, apiKey)
      return organization ? { organization, user, ticketBoxId: grant.boxId } : null
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
