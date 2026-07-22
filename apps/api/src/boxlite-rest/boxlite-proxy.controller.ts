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
  ForbiddenException,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger'
import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware'
import { Request, Response, NextFunction } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from './box-auto-resume.service'

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
  ) {}

  @All(':boxId/exec')
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
  @HttpCode(HttpStatus.OK)
  async proxyNetworkTunnel(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Query('port', ParseIntPipe) port: number,
  ) {
    const uri = await this.boxService.getNetworkTunnelUrl(boxId, authContext.organizationId, port)
    return { uri }
  }

  private async proxyToRunner(
    authContext: OrganizationAuthContext,
    boxId: string,
    targetPathForRunnerBox: (runnerBoxId: string) => string,
    req: Request,
    res: Response,
    next: NextFunction,
    policy: ProxyActivityPolicy,
    opts?: { ws?: boolean },
  ) {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    if (!box) {
      throw new NotFoundException(`Box ${boxId} not found`)
    }

    if (policy.activity) {
      // Persist activity before the readiness gate. The lifecycle sweeper rechecks
      // this Redis-buffered timestamp after taking its state lock, closing the
      // request-vs-AutoPause race without holding a lock through cold start.
      await this.boxService
        .updateLastActivityAt(box.id, new Date())
        .catch((err) => this.logger.warn(`updateLastActivityAt failed for ${box.id}: ${err}`))
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
      },
      proxyTimeout: 5 * 60 * 1000,
    }

    return createProxyMiddleware(proxyOptions)(req, res, next)
  }
}
