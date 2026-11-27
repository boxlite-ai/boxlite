/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { ForbiddenException, HttpException, Inject, Injectable, Logger } from '@nestjs/common'
import type { ClientRequest, IncomingMessage } from 'http'
import { STATUS_CODES, type OutgoingHttpHeaders } from 'node:http'
import type { Socket } from 'net'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'
import { ApiKeyService } from '../api-key/api-key.service'
import { JwtStrategy, jwtUserId } from '../auth/jwt.strategy'
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
import { AuditService } from '../audit/services/audit.service'
import { AttachAuditSession } from './attach-audit-session'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { recordBusinessEvent } from '../common/utils/business-event.util'
import { CustomHeaders } from '../common/constants/header.constants'
import {
  UPLOAD_PATH,
  UPLOAD_PROTOCOL,
  bridgeUpload,
  createUploadWebSocketServer,
  fileUploadWsEnabled,
} from './boxlite-upload-bridge'

type RunnerUpgradeRequest = IncomingMessage & {
  __boxliteRunner?: Runner
  __boxliteRunnerBoxId?: string
  __boxliteAttachAudit?: AttachAuditSession
}

// Matches /api/v1/boxes/<id>/executions/<id>/attach and the
// /api/v1/<tenant>/boxes/<id>/executions/<id>/attach shape with optional query string.
// Named groups: `tenant` (optional org id / path prefix), `boxId` and `execId`.
const ATTACH_PATH =
  /^\/api\/v1\/(?:(?<tenant>[^/]+)\/)?boxes\/(?<boxId>[^/]+)\/executions\/(?<execId>[^/?]+)\/attach(?:\?.*)?$/

type AttachMatch = { boxId: string; execId: string; tenant?: string }
type AttachAuth = { organization: Organization; user: User; ticketBoxId?: string }
type UploadAuthLimit = {
  check: () => Promise<void>
  trackFailure: () => Promise<void>
  headers: () => OutgoingHttpHeaders
}

// `/attach` streams to an execution's stdin — interactive exec — so a WS upgrade
// needs the same box-write permission the HTTP exec routes now require.
const ATTACH_REQUIRED_PERMISSIONS = [OrganizationResourcePermission.WRITE_BOXES]

/**
 * Authenticated WebSocket upgrades for execution attach and file upload.
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
  private readonly uploadWs = createUploadWebSocketServer()

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
    private readonly auditService: AuditService,
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
        proxyReqWs: (proxyReq: ClientRequest, req: IncomingMessage) => {
          const runner = (req as RunnerUpgradeRequest).__boxliteRunner
          if (runner?.apiKey) {
            proxyReq.setHeader('Authorization', `Bearer ${runner.apiKey}`)
          }
          ;(req as RunnerUpgradeRequest).__boxliteAttachAudit?.bind(proxyReq)
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

  matchesUploadPath(url: string | undefined): boolean {
    return !!url && UPLOAD_PATH.test(url)
  }

  async upgradeUpload(req: IncomingMessage, socket: Socket, head: Buffer, rateLimit?: UploadAuthLimit): Promise<void> {
    const respond = (status: number) =>
      this.respondAndClose(socket, status, STATUS_CODES[status] ?? '', rateLimit?.headers())
    const groups = req.url?.match(UPLOAD_PATH)?.groups
    if (!groups || !fileUploadWsEnabled()) return respond(404)
    const parameters = new URL(req.url!, 'http://upload.invalid').searchParams
    const overwrite = parameters.get('overwrite')
    if (!parameters.get('path') || (overwrite !== null && !/^(true|false)$/.test(overwrite))) return respond(400)
    const protocol = req.headers['sec-websocket-protocol']
    if (typeof protocol !== 'string' || !protocol.split(',').some((value) => value.trim() === UPLOAD_PROTOCOL)) {
      return respond(400)
    }

    const onSocketError = () => socket.destroy()
    socket.once('error', onSocketError)
    try {
      await rateLimit?.check()
      const tenant = groups.tenant && decodeURIComponent(groups.tenant)
      const auth = await this.authenticate(req, tenant, true)
      if (!auth) {
        await rateLimit?.trackFailure()
        return respond(401)
      }
      const box = await this.boxService.findOneByIdOrName(decodeURIComponent(groups.boxId), auth.organization.id)
      if (!box?.runnerId) return respond(404)
      const runner = await this.runnerService.findOne(box.runnerId)
      const target = runner?.apiUrl || runner?.proxyUrl
      if (!runner || !target) return respond(404)
      const url = new URL(`/v1/boxes/${encodeURIComponent(box.id)}/files`, target)
      url.searchParams.set('path', parameters.get('path')!)
      if (overwrite !== null) url.searchParams.set('overwrite', overwrite)
      const activity = () =>
        this.boxService
          .updateLastActivityAt(box.id, new Date())
          .catch(() => this.logger.warn('Upload activity update failed'))
      const log = await this.auditService.createLog(
        {
          action: AuditAction.UPLOAD_FILES,
          targetType: AuditTarget.BOX,
          targetId: box.id,
          organizationId: auth.organization.id,
          actorId: auth.user.id,
          actorEmail: auth.user.email ?? '',
          source: 'websocket-file-upload',
        },
        5000,
      )
      const lease = await this.auditService.keepPendingLogAlive(log.id).catch(async (error) => {
        await this.auditService.updateLog(log.id, { statusCode: 503, errorMessage: 'audit_lease_unavailable' }, 5000)
        throw error
      })
      const event = { name: 'box.file_upload' as const, correlationId: box.id, organizationId: auth.organization.id }
      recordBusinessEvent({ ...event, outcome: 'requested' })
      const autoStop = box.autoStop ?? 0
      const heartbeat = autoStop > 0 ? setInterval(() => void activity(), autoStop * 500).unref() : undefined
      let status = 0
      let failure = 'client_closed'
      try {
        await activity()
        if (box.autoResume) await this.autoResume.ensureReady(box.id, auth.organization)
        if (lease.signal.aborted) {
          status = 503
          failure = 'audit_lease_lost'
          return respond(status)
        }
        if (socket.destroyed || socket.readableEnded) return
        const result = await new Promise<{ status: number; failure?: string }>((resolve, reject) => {
          const close = () => resolve({ status: 0, failure: 'client_closed' })
          socket.once('close', close)
          this.uploadWs.handleUpgrade(req, socket, head, (peer) => {
            socket.off('close', close)
            bridgeUpload(peer, url, runner.apiKey, lease.signal).then(resolve, reject)
          })
        })
        status = result.status
        failure = result.failure ?? ''
      } catch (error) {
        status = error instanceof HttpException ? error.getStatus() : 500
        failure = `http_${status}`
        respond(status)
      } finally {
        clearInterval(heartbeat)
        recordBusinessEvent(
          failure ? { ...event, outcome: 'exception', exceptionType: failure } : { ...event, outcome: 'success' },
        )
        void lease
          .complete({ statusCode: status, errorMessage: failure || undefined })
          .catch(() => this.logger.warn('Failed to complete upload audit'))
      }
    } catch (error) {
      respond(error instanceof HttpException ? error.getStatus() : error instanceof URIError ? 400 : 500)
    } finally {
      socket.off('error', onSocketError)
    }
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

    if (req.headers['idempotency-key'] !== undefined) {
      this.respondAndClose(socket, 400, 'Bad Request')
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
      // Opening a WS attach is user activity,
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
      let session: AttachAuditSession | undefined
      try {
        session = await AttachAuditSession.start(
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
      } catch {
        this.logger.warn('Failed to create attach audit')
        this.respondAndClose(socket, 500, 'Internal Server Error')
        return
      }
      if (!session) return
      ;(req as RunnerUpgradeRequest).__boxliteAttachAudit = session
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
   * Attach authentication failures resolve to `null` (401). File uploads
   * distinguish permission and tenant mismatches with `ForbiddenException` (403).
   *
   * API key: the bearer must be a non-expired API key. A non-admin user must
   * still be a member of the key's organization and carry write:boxes; a system
   * admin is admitted without either. Member removal and user deletion revoke
   * the affected keys; the membership check also rejects keys left behind by
   * older deletion paths. Attach uses the key's organization. File uploads
   * resolve the organization using the HTTP file route's tenant rules.
   *
   * JWT (OIDC): when the bearer is not an API key, verify it via `JwtStrategy`
   * (same JWKS/issuer/audience as the HTTP path). A JWT carries no org, so the
   * organization is taken from the URL `{prefix}` (`urlTenant`). File uploads
   * also accept the organization header for an omitted or `default` prefix.
   * `jwtStrategy` is absent when `skipConnections` is set.
   *
   * Unlike the HTTP path, this does not consult the Redis cache used by
   * ApiKeyStrategy / OrganizationAccessGuard. Upgrade frequency is low; if
   * upgrade latency becomes a concern, add caching as a follow-up.
   */
  private async authenticate(req: IncomingMessage, urlTenant?: string, upload = false): Promise<AttachAuth | null> {
    try {
      const header = req.headers['authorization']
      const headerValue = Array.isArray(header) ? header[0] : header
      if (!headerValue || !/^bearer\s+/i.test(headerValue)) return null
      const token = headerValue.replace(/^bearer\s+/i, '').trim()
      if (!token) return null

      // Try the API-key credential first. A lookup miss falls through to JWT.
      const apiKey = await this.apiKeyService.getApiKeyByValue(token).catch(() => null)
      if (apiKey) {
        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null
        // The system role comes from the key's user, as ApiKeyStrategy resolves it
        // on the HTTP path.
        const user = await this.userService.findOne(apiKey.userId)
        if (!user) return null
        const orgId = upload && urlTenant && urlTenant !== 'default' ? urlTenant : apiKey.organizationId
        if (orgId !== apiKey.organizationId && user.role !== SystemRole.ADMIN) throw new ForbiddenException()
        if (!(await this.authorizeAttach(user, orgId, apiKey))) {
          if (upload) throw new ForbiddenException()
          return null
        }
        const organization = await this.organizationService.findOne(orgId)
        return organization ? { organization, user } : null
      }

      // JWT (OIDC) supplies the user identity. The request supplies the organization.
      if (!this.jwtStrategy) return null
      if (upload && (!urlTenant || urlTenant === 'default')) {
        const org = req.headers[CustomHeaders.ORGANIZATION_ID.name.toLowerCase()]
        urlTenant = typeof org === 'string' ? org : undefined
      }
      if (!urlTenant || urlTenant === 'default') return null
      const userId = jwtUserId(await this.jwtStrategy.verifyToken(token))
      if (!userId) return null

      const user = await this.userService.findOne(userId)
      if (!user) return null
      if (!(await this.authorizeAttach(user, urlTenant))) {
        if (upload) throw new ForbiddenException()
        return null
      }
      const organization = await this.organizationService.findOne(urlTenant)
      return organization ? { organization, user } : null
    } catch (error) {
      if (upload && error instanceof ForbiddenException) throw error
      // Invalid signatures and failed lookups produce a 401 in both upgrade handlers.
      return null
    }
  }

  /**
   * Authorize an attach upgrade with OrganizationResourceActionGuard's policy,
   * which the WS upgrade never reaches. A system admin is not organization-scoped
   * and is admitted without membership, exactly as OrganizationAccessGuard admits
   * it on the HTTP path. Everyone else must be a current member and must carry
   * write:boxes (an org owner without an API key is exempt). Attach streams to an
   * execution's stdin, i.e. interactive exec.
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
      return organization ? { organization, user, ticketBoxId: grant.boxId } : null
    } catch {
      return null
    }
  }

  private respondAndClose(socket: Socket, status: number, reason: string, headers: OutgoingHttpHeaders = {}): void {
    try {
      const extra = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('')
      socket.write(`HTTP/1.1 ${status} ${reason}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`)
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
