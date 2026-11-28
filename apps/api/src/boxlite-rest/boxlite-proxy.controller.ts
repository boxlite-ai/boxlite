/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Audit, AUDIT_TARGET_ID } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import {
  Controller,
  All,
  Get,
  Delete,
  Param,
  Req,
  Res,
  Next,
  UseGuards,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Post,
  Query,
  Body,
  Header,
  ValidationPipe,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger'
import { createProxyMiddleware, errorResponsePlugin, fixRequestBody, Options } from 'http-proxy-middleware'
import { Request, Response, NextFunction } from 'express'
import type { IncomingMessage } from 'node:http'
import { context, propagation } from '@opentelemetry/api'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService, ProxyAdmission } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { AUTO_RESUMABLE_STATES, BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { reportedBoxState } from '../box/utils/box-state.util'
import { Box } from '../box/entities/box.entity'
import { TunnelService } from '../box/services/tunnel.service'
import { PrepareTunnelDto } from '../box/dto/tunnel.dto'
import { RunnerProxyAgents } from './runner-proxy-agents'
import { requestContext, UserContext } from '../common/decorators/user-context.decorator'
import { Context } from '../common/context/context'
import { recordBusinessEvent, recordOutcomes } from '../common/utils/business-event.util'
import { emitTiming, startTiming, TimingStatus } from '../common/utils/tti-timing.util'
import {
  startTimedOperation,
  TimedOperation,
  WithInstrumentation,
  withResponseInstrumentation,
} from '../common/decorators/otel.decorator'

type ProxyActivityPolicy = { activity: boolean; autoResume: boolean }
const USER_OPERATION: ProxyActivityPolicy = { activity: true, autoResume: true }
const OBSERVATION_ONLY: ProxyActivityPolicy = { activity: false, autoResume: false }

// The runner can implicitly boot a stopped box on exec, so disabled cloud
// auto-resume must be enforced before forwarding the request.
function requireExecReady(box: Box, boxId: string): void {
  if (!box.autoResume && (reportedBoxState(box) !== BoxState.STARTED || box.desiredState !== BoxDesiredState.STARTED)) {
    throw new ConflictException(`Box ${boxId} is not running and auto-resume is disabled; start it first`)
  }
}

// SSH configure may wake a box only the way auto-resume would, and only onto
// the image's default command: a box with an explicit cmd/entrypoint must be
// started first, as the SDKs require (openapi `configureSsh`). Joining a start
// already in flight is fine; submitting one is not.
function refuseImplicitSshStart(box: Box, boxId: string): void {
  const state = reportedBoxState(box)
  if (state === BoxState.STARTED && box.desiredState === BoxDesiredState.STARTED) {
    return
  }
  if (!box.autoResume) {
    throw new ConflictException(`Box ${boxId} is not running and auto-resume is disabled; start it first`)
  }
  if (state !== BoxState.STARTED && !AUTO_RESUMABLE_STATES.includes(state)) {
    throw new ConflictException(`Box ${boxId} is not running (state: ${state})`)
  }
  const submitsStart =
    state === BoxState.STOPPED || state === BoxState.STOPPING || box.desiredState === BoxDesiredState.STOPPED
  if (submitsStart && (box.cmd?.length || box.entrypoint?.length)) {
    throw new ConflictException(`Box ${boxId} has an explicit cmd or entrypoint; start it before configuring SSH`)
  }
}

// SSH status never starts a box. The runner answers a stopped box's
// disabled status itself; a box between states has no answer to give yet.
function requireSshObservable(box: Box, boxId: string): void {
  if (box.state !== BoxState.STARTED && box.state !== BoxState.STOPPED) {
    throw new ConflictException(`Box ${boxId} is ${box.state}; SSH can be read once it is started or stopped`)
  }
}
/** A proxied call that is a business operation: a command started, or files uploaded. */
type ProxiedOperation = 'box.exec' | 'box.file_upload'

function requireSshRunning(box: Box, boxId: string): void {
  const state = reportedBoxState(box)
  if (state !== BoxState.STARTED || box.desiredState !== BoxDesiredState.STARTED) {
    throw new ConflictException(`Box ${boxId} is not running (state: ${state}); start it before changing SSH`)
  }
}

// Spec-first surface (openapi/box.openapi.yaml). Must stay out of the product
// spec: @All() expands to the SEARCH verb, which OpenAPI 3.0 cannot express.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteProxyController {
  private readonly logger = new Logger(BoxliteProxyController.name)

  constructor(
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
    private readonly autoResume: BoxAutoResumeService,
    private readonly tunnelService: TunnelService,
    private readonly proxyAgents: RunnerProxyAgents,
  ) {}

  @All(':boxId/exec')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.EXECUTE,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    methods: ['POST'],
    completion: 'response',
  })
  async proxyExec(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const startedAt = startTiming()
    let end: { at: ReturnType<typeof startTiming>; status: TimingStatus } | undefined
    const captureEnd = (closed: boolean) => {
      if (end) return
      try {
        end = { at: startTiming(), status: closed || res.statusCode >= 400 ? 'error' : 'ok' }
      } catch {}
    }
    // Capture the response end even while admission is pending; don't write yet.
    try {
      res.once('finish', () => captureEnd(false))
      res.once('close', () => captureEnd(true))
      if (res.writableFinished) captureEnd(false)
      else if (res.destroyed || res.closed) captureEnd(true)
    } catch {}

    const proxy = () =>
      this.proxyToRunner(
        authContext,
        boxId,
        (runnerBoxId) => `/v1/boxes/${runnerBoxId}/exec`,
        req,
        res,
        next,
        USER_OPERATION,
        {
          operation: req.method === 'POST' ? 'box.exec' : undefined,
          admit: req.method === 'POST' ? requireExecReady : undefined,
          timing: (resolvedBoxId) => {
            let forwardedAt: ReturnType<typeof startTiming>
            let execId: string | undefined
            let recorded = false
            const ids = () => ({ box_id: resolvedBoxId, ...(execId ? { exec_id: execId } : {}) })
            const recordForwarded = (status: TimingStatus) => {
              if (forwardedAt === undefined) return
              const started = forwardedAt
              forwardedAt = undefined
              try {
                emitTiming('exec', 'exec.forwarded', status, started, ids())
              } catch {}
            }
            const record = () => {
              if (recorded || !end) return
              recorded = true
              recordForwarded('error')
              if (end.at === undefined) return
              try {
                emitTiming('exec', 'exec.request', end.status, startedAt, ids(), end.at)
              } catch {}
            }
            try {
              if (end) record()
              else {
                res.once('finish', record)
                res.once('close', record)
              }
            } catch {}

            return {
              start: () => {
                forwardedAt = startTiming()
              },
              proxyRes: (upstream) => {
                try {
                  execId = upstream.headers.location?.match(/\/executions\/([^/?#]+)(?:[?#]|$)/)?.[1]
                  recordForwarded((upstream.statusCode ?? 500) >= 400 ? 'error' : 'ok')
                } catch {}
              },
            }
          },
        },
      )
    return req.method === 'POST'
      ? withResponseInstrumentation('box.exec.http', res, proxy, {
          component: BoxliteProxyController.name,
          method: 'proxyExec',
        })
      : proxy()
  }

  @All(':boxId/executions/:execId/signal')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.SIGNAL_EXECUTION,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    methods: ['POST'],
    completion: 'response',
    requestMetadata: { executionId: (req) => req.params.execId },
  })
  async proxyExecSignal(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('execId') execId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/executions/${execId}/signal`,
      req,
      res,
      next,
      USER_OPERATION,
    )
  }

  @All(':boxId/executions/:execId/resize')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async proxyExecResize(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('execId') execId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/executions/${execId}/resize`,
      req,
      res,
      next,
      USER_OPERATION,
    )
  }

  @Get(':boxId/executions')
  async proxyExecList(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/executions`,
      req,
      res,
      next,
      OBSERVATION_ONLY,
    )
  }

  @Get(':boxId/executions/:execId')
  async proxyExecStatus(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('execId') execId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/executions/${execId}`,
      req,
      res,
      next,
      USER_OPERATION,
    )
  }

  @Delete(':boxId/executions/:execId')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.TERMINATE_EXECUTION,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    methods: ['DELETE'],
    completion: 'response',
    requestMetadata: { executionId: (req) => req.params.execId },
  })
  async proxyExecKill(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('execId') execId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/executions/${execId}`,
      req,
      res,
      next,
      USER_OPERATION,
    )
  }

  // /executions/:execId/attach is a WebSocket-only route. Real WS upgrades
  // bypass Express entirely and are handled by BoxliteWsProxyService via the
  // `server.on('upgrade', ...)` hook registered in main.ts. Plain HTTP GETs
  // to this path (callers that forgot the Upgrade headers) fall through to
  // a NestJS 404, which is the correct answer.

  @All(':boxId/files')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.UPLOAD_FILES,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    methods: ['PUT'],
    completion: 'response',
  })
  async proxyFiles(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/files${query}`,
      req,
      res,
      next,
      USER_OPERATION,
      { proxyTimeoutMs: 0, operation: req.method === 'PUT' ? 'box.file_upload' : undefined },
    )
  }

  @All(':boxId/metrics')
  async proxyMetrics(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/metrics`,
      req,
      res,
      next,
      OBSERVATION_ONLY,
    )
  }

  // The runner applies the configuration once; nothing on either hop retries
  // it, because every accepted call restarts the guest listener.
  @Post(':boxId/ssh')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.CONFIGURE_SSH,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    methods: ['POST'],
    completion: 'response',
  })
  async configureSsh(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/ssh`,
      req,
      res,
      next,
      USER_OPERATION,
      { admit: refuseImplicitSshStart },
    )
  }

  @Get(':boxId/ssh')
  async getSshStatus(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/ssh`,
      req,
      res,
      next,
      OBSERVATION_ONLY,
      { admit: requireSshObservable },
    )
  }

  @Post(':boxId/ssh/enable')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.ENABLE_SSH,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    methods: ['POST'],
    completion: 'response',
  })
  async enableSsh(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/ssh/enable`,
      req,
      res,
      next,
      OBSERVATION_ONLY,
      { admit: requireSshRunning },
    )
  }

  @Delete(':boxId/ssh')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.DISABLE_SSH,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    methods: ['DELETE'],
    completion: 'response',
  })
  async disableSsh(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/ssh`,
      req,
      res,
      next,
      OBSERVATION_ONLY,
      { admit: requireSshRunning },
    )
  }

  @Post(':boxId/network/tunnel')
  @Header('Cache-Control', 'no-store')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @HttpCode(HttpStatus.OK)
  @Audit({
    action: AuditAction.CREATE_TUNNEL,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    requestMetadata: { port: (req) => req.query.port },
  })
  async proxyNetworkTunnel(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Query('port', ParseIntPipe) port: number,
    @UserContext() ctx: Context,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) options: PrepareTunnelDto = {},
    @Req() request?: Request,
  ) {
    // findOneByIdOrName already 404s for a missing/destroyed box.
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    if (request) request[AUDIT_TARGET_ID] = box.id
    return recordOutcomes(
      { name: 'tunnel.create', correlationId: box.id, organizationId: box.organizationId, ctx },
      () => this.openTunnel(box, boxId, port, authContext.organizationId, options),
      (error) => (error instanceof ConflictException ? 'conflict' : 'internal'),
    )
  }

  private async openTunnel(box: Box, boxId: string, port: number, organizationId: string, options: PrepareTunnelDto) {
    // Tunnel URLs expose the box to the public internet, so only a box with
    // inbound access enabled can use one. Any other box is reached through
    // the authenticated API.
    if (!box.inboundEnabled) {
      throw new ConflictException(
        `Box ${boxId} has inbound access disabled; enable inbound access before opening a tunnel`,
      )
    }

    // POL-326/POL-352: opening a tunnel is user activity, exactly like the
    // proxyToRunner routes. Persist it before the readiness gate so the
    // AutoStop sweeper cannot reap the box we are about to hand out; the
    // sweeper rechecks this Redis-buffered timestamp after taking its state
    // lock.
    await this.boxService
      .updateLastActivityAt(box.id, new Date())
      .catch((err) => this.logger.warn(`updateLastActivityAt failed for ${box.id}: ${err}`))

    // Refuse at once a box the CONNECT could never wake. A box it can wake
    // gets its URI as it is: the proxy wakes it on the CONNECT, and waits for
    // the service to listen, so waking it here would only hold the caller.
    if (box.state !== BoxState.STARTED && (!box.autoResume || !AUTO_RESUMABLE_STATES.includes(box.state))) {
      throw new ConflictException(`Box ${boxId} is not running (state: ${box.state})`)
    }

    const uri = await this.boxService.getNetworkTunnelUrl(boxId, organizationId, port)
    const access = await this.tunnelService.prepare(box.id, port, options.isPublic ?? true)
    return { uri, ...access }
  }

  // Revoking needs neither inbound access nor a running box: it only withdraws
  // the declaration, so a port stays revocable after either is turned off.
  @Delete(':boxId/network/tunnel')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit({
    action: AuditAction.REVOKE_TUNNEL,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    requestMetadata: { port: (req) => req.query.port },
  })
  async revokeNetworkTunnel(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Query('port', ParseIntPipe) port: number,
    @Req() request?: Request,
  ): Promise<void> {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    if (request) request[AUDIT_TARGET_ID] = box.id
    await this.tunnelService.revoke(box.id, port)
  }

  @WithInstrumentation('box.runner_proxy_setup')
  private async proxyToRunner(
    authContext: OrganizationAuthContext,
    boxId: string,
    targetPathForRunnerBox: (runnerBoxId: string) => string,
    req: Request,
    res: Response,
    next: NextFunction,
    policy: ProxyActivityPolicy,
    // admit throws to refuse the request after activity is recorded and before
    // any resume.
    opts?: {
      ws?: boolean
      proxyTimeoutMs?: number
      admit?: ProxyAdmission
      operation?: ProxiedOperation
      timing?: (boxId: string) => Pick<NonNullable<Options['on']>, 'start' | 'proxyRes'>
    },
  ) {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    if (!box) {
      throw new NotFoundException(`Box ${boxId} not found`)
    }

    req[AUDIT_TARGET_ID] = box.id
    if (opts?.operation) {
      this.recordProxiedOperation(opts.operation, box, requestContext(req), res)
    }

    if (policy.activity) {
      // The state-locked sweeper waits briefly and rechecks the Redis buffer
      // before stopping a stale candidate. Activity remains best-effort and
      // never delays readiness, auto-resume, or the runner request.
      void this.boxService
        .updateLastActivityAt(box.id, new Date())
        .catch((err) => this.logger.warn(`updateLastActivityAt failed for ${box.id}: ${err}`))
    }

    if (policy.activity && typeof box.autoStop === 'number' && box.autoStop > 0) {
      // A long-running operation (a file upload/download, a streaming exec) is
      // still activity for its whole lifetime, not just its first request.
      // Refresh the idle timer periodically so the AutoStop sweeper does not
      // reap the box mid-transfer; stop once the response completes or errors.
      const stopHeartbeat = this.startActivityHeartbeat(box.id, box.autoStop)
      let stopped = false
      const stop = (): void => {
        if (stopped) return
        stopped = true
        stopHeartbeat()
      }
      res.once('close', stop)
      res.once('finish', stop)
      res.once('error', stop)
    }

    opts?.admit?.(box, boxId)

    const resume =
      policy.autoResume && box.autoResume
        ? opts?.operation === 'box.exec'
          ? this.autoResume.ensureReady(box.id, authContext.organization, opts?.admit, box)
          : this.autoResume.ensureReady(box.id, authContext.organization, opts?.admit)
        : Promise.resolve()
    const [resumeResult, runnerResult] = await Promise.allSettled([
      resume,
      this.runnerService.findProxyTarget(box.runnerId),
    ])
    if (resumeResult.status === 'rejected') throw resumeResult.reason
    if (runnerResult.status === 'rejected') throw runnerResult.reason
    const runner = runnerResult.value
    if (!runner) {
      throw new NotFoundException(`Runner for box ${boxId} not found`)
    }

    const targetUrl = runner.apiUrl || runner.proxyUrl
    if (!targetUrl) {
      throw new NotFoundException(`Runner endpoint for box ${boxId} not found`)
    }

    const proxyContext = context.active()
    const protocol = targetUrl.toLowerCase().startsWith('https:') ? 'https' : 'http'
    const spanAttributes = {
      component: BoxliteProxyController.name,
      method: 'proxyToRunner',
      box_id: box.id,
      'runner.protocol': protocol,
      ...(typeof req.params?.execId === 'string' ? { execution_id: req.params.execId } : {}),
    }
    const metricAttributes: Record<string, string> = {
      component: BoxliteProxyController.name,
      method: 'proxyToRunner',
      protocol,
      reused_socket: 'unknown',
    }
    let upstream: TimedOperation | undefined
    let ttfb: TimedOperation | undefined
    const finishUpstream = (status: 'success' | 'error' | 'timeout', error?: unknown) => {
      ttfb?.finish(status, error)
      upstream?.finish(status, error)
    }

    const timing = opts?.timing?.(box.id)
    const proxyOptions: Options = {
      target: targetUrl,
      agent: this.proxyAgents.forTarget(targetUrl),
      secure: false,
      changeOrigin: true,
      autoRewrite: true,
      ws: opts?.ws ?? false,
      plugins: [errorResponsePlugin],
      pathRewrite: () => targetPathForRunnerBox(box.id),
      on: {
        proxyReq: (proxyReq: any, originalReq: any) => {
          timing?.start?.(proxyReq, originalReq, targetUrl)
          upstream = startTimedOperation('box.runner_proxy_upstream', spanAttributes, metricAttributes, proxyContext)
          ttfb = startTimedOperation('box.runner_proxy_ttfb', spanAttributes, metricAttributes, proxyContext)
          const recordSocket = () => {
            const reused = proxyReq.reusedSocket === true
            metricAttributes.reused_socket = String(reused)
            upstream?.setAttributes({ 'runner.reused_socket': reused })
            ttfb?.setAttributes({ 'runner.reused_socket': reused })
          }
          proxyReq.once('socket', recordSocket)
          if (proxyReq.socket) recordSocket()
          proxyReq.setHeader('Authorization', `Bearer ${runner.apiKey}`)
          propagation.inject(upstream.ctx, {}, { set: (_carrier, key, value) => proxyReq.setHeader(key, value) })
          proxyReq.once('timeout', () => finishUpstream('timeout', new Error('upstream request timed out')))
          proxyReq.once('error', (error) => finishUpstream('error', error))
          fixRequestBody(proxyReq, originalReq)
        },
        proxyRes: (proxyRes: IncomingMessage) => {
          timing?.proxyRes?.(proxyRes, req, res)
          const responseAttributes = { 'http.status_code': proxyRes.statusCode ?? 0 }
          ttfb?.finish((proxyRes.statusCode ?? 500) >= 400 ? 'error' : 'success', undefined, responseAttributes)
          proxyRes.once('end', () => {
            upstream?.finish((proxyRes.statusCode ?? 500) >= 400 ? 'error' : 'success', undefined, responseAttributes)
          })
          proxyRes.once('error', (error) => finishUpstream('error', error))
          proxyRes.once('close', () => {
            if (!proxyRes.readableEnded) finishUpstream('error', new Error('upstream response closed early'))
          })
        },
        error: (error: Error & { code?: string }) => {
          finishUpstream(error.code === 'ETIMEDOUT' ? 'timeout' : 'error', error)
        },
      },
      proxyTimeout: opts?.proxyTimeoutMs ?? 5 * 60 * 1000,
    }

    return createProxyMiddleware(proxyOptions)(req, res, next)
  }

  /**
   * Records the operation as requested now and its outcome when the response
   * ends: the runner's (or a gateway error's) status decides success, and a
   * client that disconnects first leaves an exception.
   */
  private recordProxiedOperation(name: ProxiedOperation, box: Box, ctx: Context, res: Response): void {
    const event = {
      name,
      correlationId: box.id,
      organizationId: box.organizationId,
      ctx,
    }
    recordBusinessEvent({ ...event, outcome: 'requested' })
    let recorded = false
    const finish = (exceptionType?: string) => {
      if (recorded) return
      recorded = true
      res.off('finish', onFinish)
      res.off('close', onClose)
      if (exceptionType) recordBusinessEvent({ ...event, outcome: 'exception', exceptionType })
      else recordBusinessEvent({ ...event, outcome: 'success' })
    }
    const onFinish = () => finish(res.statusCode >= 400 ? `http_${res.statusCode}` : undefined)
    const onClose = () => finish('client_closed')
    res.once('finish', onFinish)
    res.once('close', onClose)
    // The asynchronous box lookup may have outlived the response's terminal event.
    if (res.writableFinished) onFinish()
    else if (res.destroyed || res.closed) onClose()
  }

  private startActivityHeartbeat(boxId: string, autoStopSeconds: number): () => void {
    // Half the autoStop window (in ms) so the idle deadline can never lapse
    // between two beats, however the sweeper samples it. Redis writes are
    // throttled by the activity service's own per-box lock.
    const intervalMs = autoStopSeconds * 500
    const timer = setInterval(() => {
      void this.boxService
        .updateLastActivityAt(boxId, new Date())
        .catch((err) => this.logger.warn(`updateLastActivityAt heartbeat failed for ${boxId}: ${err}`))
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
