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
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
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

// Caller-side wait cap for the best-effort control-plane start hint. The hint's
// DB work is itself bounded by a lock_timeout (see conditionalStartForProxy),
// which aborts the statement and frees the connection on row-lock contention;
// this race only limits how long *exec* waits on the hint, so the proxy
// proceeds even if the hint is momentarily slow. Both bounds are 2s.
const PROXY_START_HINT_TIMEOUT_MS = 2000
const START_HINT_TIMED_OUT = Symbol('start-hint-timed-out')

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
  ) {}

  @All(':boxId/exec')
  async proxyExec(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await this.startHint(boxId, authContext)
    return this.proxyToRunner(authContext, boxId, (runnerBoxId) => `/v1/boxes/${runnerBoxId}/exec`, req, res, next)
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
    await this.startHint(boxId, authContext)
    const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''
    return this.proxyToRunner(
      authContext,
      boxId,
      (runnerBoxId) => `/v1/boxes/${runnerBoxId}/files${query}`,
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
    await this.startHint(boxId, authContext)
    return this.proxyToRunner(authContext, boxId, (runnerBoxId) => `/v1/boxes/${runnerBoxId}/metrics`, req, res, next)
  }

  /**
   * Tell the control plane that the proxied call (exec / files / metrics) is
   * about to auto-start a stopped box in the runtime, so PG agrees and
   * sync-states does not promptly stop it back.
   *
   * - Suspended org → ForbiddenException re-thrown → caller sees 403, proxy
   *   never runs (same gate as POST /boxes/:id/start).
   * - Billing 402/503 or timeout while enforcement is enabled → re-thrown so
   *   runtime auto-start cannot bypass prepaid admission.
   * - Any other failure → swallowed; box_sync reconciles state on its next tick.
   * - Caller-side time-boxed via PROXY_START_HINT_TIMEOUT_MS; the hint's DB work
   *   is independently bounded by a lock_timeout (conditionalStartForProxy), so
   *   a contended row aborts at the DB and frees its connection rather than
   *   waiting out this race detached.
   */
  private async startHint(boxId: string, authContext: OrganizationAuthContext) {
    try {
      const result = await Promise.race([
        this.boxService.ensureStartedForProxy(boxId, authContext.organization),
        new Promise<typeof START_HINT_TIMED_OUT>((resolve) =>
          setTimeout(() => resolve(START_HINT_TIMED_OUT), PROXY_START_HINT_TIMEOUT_MS),
        ),
      ])
      if (result === START_HINT_TIMED_OUT && this.boxService.isBillingEnforcementEnabled()) {
        throw new ServiceUnavailableException('Billing access check timed out')
      }
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw err
      }
      if (
        this.boxService.isBillingEnforcementEnabled() &&
        err instanceof HttpException &&
        [HttpStatus.PAYMENT_REQUIRED, HttpStatus.SERVICE_UNAVAILABLE].includes(err.getStatus())
      ) {
        throw err
      }
      this.logger.warn(`ensureStartedForProxy failed for ${boxId}: ${err}`)
    }
  }

  private async proxyToRunner(
    authContext: OrganizationAuthContext,
    boxId: string,
    targetPathForRunnerBox: (runnerBoxId: string) => string,
    req: Request,
    res: Response,
    next: NextFunction,
    opts?: { ws?: boolean },
  ) {
    const box = await this.boxService.findOneByIdOrName(boxId, authContext.organizationId)
    if (!box) {
      throw new NotFoundException(`Box ${boxId} not found`)
    }

    // Any SDK-initiated proxy
    // call counts as user activity, so the autostop cron does not reap an
    // actively used box. Best-effort: never block the proxy on this.
    this.boxService
      .updateLastActivityAt(box.id, new Date())
      .catch((err) => this.logger.warn(`updateLastActivityAt failed for ${box.id}: ${err}`))

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
