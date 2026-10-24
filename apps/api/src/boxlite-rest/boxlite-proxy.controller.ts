/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

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
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware'
import { Request, Response, NextFunction } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { AUTO_RESUMABLE_STATES, BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxState } from '../box/enums/box-state.enum'
import { TunnelService } from '../box/services/tunnel.service'
import { PrepareTunnelDto } from '../box/dto/tunnel.dto'

type ProxyActivityPolicy = { activity: boolean; autoResume: boolean }
const USER_OPERATION: ProxyActivityPolicy = { activity: true, autoResume: true }
const OBSERVATION_ONLY: ProxyActivityPolicy = { activity: false, autoResume: false }

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
  ) {}

  @All(':boxId/exec')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async proxyExec(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/exec`,
      req,
      res,
      next,
      USER_OPERATION,
    )
  }

  @All(':boxId/executions/:execId/signal')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
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
      { proxyTimeoutMs: 0 },
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

  @Post(':boxId/network/tunnel')
  @Header('Cache-Control', 'no-store')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @HttpCode(HttpStatus.OK)
  async proxyNetworkTunnel(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Query('port', ParseIntPipe) port: number,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })) options: PrepareTunnelDto = {},
  ) {
    // findOneByIdOrName already 404s for a missing/destroyed box.
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)

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

    const uri = await this.boxService.getNetworkTunnelUrl(boxId, authContext.organizationId, port)
    const access = await this.tunnelService.prepare(box.id, port, options.isPublic ?? true)
    return { uri, ...access }
  }

  // Revoking needs neither inbound access nor a running box: it only withdraws
  // the declaration, so a port stays revocable after either is turned off.
  @Delete(':boxId/network/tunnel')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeNetworkTunnel(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Query('port', ParseIntPipe) port: number,
  ): Promise<void> {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    await this.tunnelService.revoke(box.id, port)
  }

  private async proxyToRunner(
    authContext: OrganizationAuthContext,
    boxId: string,
    targetPathForRunnerBox: (runnerBoxId: string) => string,
    req: Request,
    res: Response,
    next: NextFunction,
    policy: ProxyActivityPolicy,
    opts?: { ws?: boolean; proxyTimeoutMs?: number },
  ) {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    if (!box) {
      throw new NotFoundException(`Box ${boxId} not found`)
    }

    if (policy.activity) {
      // Persist activity before the readiness gate. The lifecycle sweeper rechecks
      // this Redis-buffered timestamp after taking its state lock, closing the
      // request-vs-AutoStop race without holding a lock through cold start.
      await this.boxService
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

    if (policy.autoResume && box.autoResume) {
      await this.autoResume.ensureReady(box.id, authContext.organization)
    }

    const runner = await this.runnerService.findOne(box.runnerId)
    if (!runner) {
      throw new NotFoundException(`Runner for box ${boxId} not found`)
    }

    const targetUrl = runner.apiUrl || runner.proxyUrl
    if (!targetUrl) {
      throw new NotFoundException(`Runner endpoint for box ${boxId} not found`)
    }

    const proxyOptions: Options = {
      target: targetUrl,
      secure: false,
      changeOrigin: true,
      autoRewrite: true,
      ws: opts?.ws ?? false,
      pathRewrite: () => targetPathForRunnerBox(box.id),
      on: {
        proxyReq: (proxyReq: any, originalReq: any) => {
          proxyReq.setHeader('Authorization', `Bearer ${runner.apiKey}`)
          fixRequestBody(proxyReq, originalReq)
        },
        proxyRes: (proxyRes: any, _req: any, res: any) => {
          // Carry the file-download archive-shape hint through the proxy so the
          // client's copy_out can distinguish single-file vs directory streams.
          const shape = proxyRes.headers?.['x-boxlite-source-is-dir']
          if (shape) {
            res.setHeader('x-boxlite-source-is-dir', shape)
          }
        },
      },
      proxyTimeout: opts?.proxyTimeoutMs ?? 5 * 60 * 1000,
    }

    return createProxyMiddleware(proxyOptions)(req, res, next)
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
