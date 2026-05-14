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
} from '@nestjs/common'
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger'
import {
  createProxyMiddleware,
  fixRequestBody,
  Options,
} from 'http-proxy-middleware'
import { Request, Response, NextFunction } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { SandboxService } from '../sandbox/services/sandbox.service'
import { RunnerService } from '../sandbox/services/runner.service'

@ApiTags('BoxLite REST')
@Controller('v1/:prefix/boxes')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteProxyController {
  private readonly logger = new Logger(BoxliteProxyController.name)

  constructor(
    private readonly sandboxService: SandboxService,
    private readonly runnerService: RunnerService,
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
      `/v1/boxes/${boxId}/exec`,
      req,
      res,
      next,
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
      `/v1/boxes/${boxId}/executions/${execId}/signal`,
      req,
      res,
      next,
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
      `/v1/boxes/${boxId}/executions/${execId}/resize`,
      req,
      res,
      next,
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
      `/v1/boxes/${boxId}/executions/${execId}`,
      req,
      res,
      next,
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
      `/v1/boxes/${boxId}/executions/${execId}`,
      req,
      res,
      next,
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
    const query = req.url.includes('?')
      ? req.url.substring(req.url.indexOf('?'))
      : ''
    return this.proxyToRunner(
      authContext,
      boxId,
      `/v1/boxes/${boxId}/files${query}`,
      req,
      res,
      next,
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
      `/v1/boxes/${boxId}/metrics`,
      req,
      res,
      next,
    )
  }

  private async proxyToRunner(
    authContext: OrganizationAuthContext,
    boxId: string,
    targetPath: string,
    req: Request,
    res: Response,
    next: NextFunction,
    opts?: { ws?: boolean },
  ) {
    const sandbox = await this.sandboxService.findOneByIdOrName(
      boxId,
      authContext.organizationId,
    )
    if (!sandbox) {
      throw new NotFoundException(`Box ${boxId} not found`)
    }

    // Mirror legacy toolbox.deprecated.service.ts:111 — any SDK-initiated proxy
    // call counts as user activity, so the autostop cron does not reap an
    // actively used sandbox. Best-effort: never block the proxy on this.
    this.sandboxService
      .updateLastActivityAt(sandbox.id, new Date())
      .catch((err) =>
        this.logger.warn(`updateLastActivityAt failed for ${sandbox.id}: ${err}`),
      )

    const runner = await this.runnerService.findOne(sandbox.runnerId)
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
      pathRewrite: () => targetPath,
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
