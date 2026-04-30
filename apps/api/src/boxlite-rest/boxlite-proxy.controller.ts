/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Controller,
  All,
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

  @All(':boxId/executions/:execId/output')
  async proxyExecOutput(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('execId') execId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.streamFromRunner(
      authContext,
      boxId,
      `/v1/boxes/${boxId}/executions/${execId}/output`,
      req,
      res,
      next,
    )
  }

  @All(':boxId/executions/:execId/input')
  async proxyExecInput(
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
      `/v1/boxes/${boxId}/executions/${execId}/input`,
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
  ) {
    const sandbox = await this.sandboxService.findOneByIdOrName(
      boxId,
      authContext.organizationId,
    )
    if (!sandbox) {
      throw new NotFoundException(`Box ${boxId} not found`)
    }

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

  private async streamFromRunner(
    authContext: OrganizationAuthContext,
    boxId: string,
    targetPath: string,
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const sandbox = await this.sandboxService.findOneByIdOrName(
        boxId,
        authContext.organizationId,
      )
      if (!sandbox) {
        throw new NotFoundException(`Box ${boxId} not found`)
      }

      const runner = await this.runnerService.findOne(sandbox.runnerId)
      if (!runner) {
        throw new NotFoundException(`Runner for box ${boxId} not found`)
      }

      const targetBaseUrl = runner.apiUrl || runner.proxyUrl
      if (!targetBaseUrl) {
        throw new NotFoundException(
          `Runner endpoint for box ${boxId} not found`,
        )
      }

      const targetUrl = new URL(targetPath, targetBaseUrl)
      const runnerResponse = await fetch(targetUrl, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${runner.apiKey}`,
          Accept: req.header('accept') || 'text/event-stream',
        },
      })

      res.status(runnerResponse.status)
      runnerResponse.headers.forEach((value, key) => {
        if (
          !['connection', 'content-length', 'transfer-encoding'].includes(
            key.toLowerCase(),
          )
        ) {
          res.setHeader(key, value)
        }
      })

      if (!runnerResponse.body) {
        res.end()
        return
      }

      const reader = runnerResponse.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          if (value && !res.write(Buffer.from(value))) {
            await new Promise((resolve) => res.once('drain', resolve))
          }
        }
      } finally {
        reader.releaseLock()
        res.end()
      }
    } catch (error) {
      if (res.headersSent) {
        this.logger.error(
          `Runner stream failed after response started for box ${boxId}: ${error}`,
        )
        if (!res.writableEnded) {
          res.end()
        }
        return
      }
      next(error)
    }
  }
}
