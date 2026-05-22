/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Controller,
  All,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Req,
  Res,
  Next,
  UseGuards,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiConsumes,
  ApiBody,
  ApiResponse,
  ApiExcludeEndpoint,
} from '@nestjs/swagger'
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
@ApiParam({
  name: 'prefix',
  required: true,
  description: 'API version prefix routed to the runner (e.g. v0, v1).',
  schema: { type: 'string' },
})
export class BoxliteProxyController {
  private readonly logger = new Logger(BoxliteProxyController.name)

  constructor(
    private readonly sandboxService: SandboxService,
    private readonly runnerService: RunnerService,
  ) {}

  @All(':boxId/exec')
  @ApiExcludeEndpoint()
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
  @ApiExcludeEndpoint()
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
  @ApiExcludeEndpoint()
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

  // The four /files routes used to share a single @All proxy. NestJS
  // SwaggerModule's metadata explorer skips @All by design (it only emits
  // entries for the six concrete verb decorators), so the routes never
  // appeared in apps/api-client-go. Splitting per verb makes them visible
  // to the spec at the cost of a little duplicated proxy plumbing.
  @Get(':boxId/files')
  @ApiOperation({
    operationId: 'downloadBoxFile',
    summary: 'Download a single file from a box',
    description:
      'Returns the raw file bytes at the given path inside the box. Proxied to the runner.',
  })
  @ApiQuery({
    name: 'path',
    required: true,
    schema: { type: 'string' },
    description: 'Path of the file inside the box',
  })
  @ApiResponse({ status: 200, description: 'Raw file bytes' })
  @ApiResponse({ status: 404, description: 'Box or file not found' })
  async proxyFileDownload(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyFilesPath(authContext, boxId, req, res, next)
  }

  @Put(':boxId/files')
  @ApiOperation({
    operationId: 'uploadBoxFile',
    summary: 'Upload a single file to a box',
    description:
      'Streams the raw request body to the given path inside the box. Proxied to the runner.',
  })
  @ApiQuery({
    name: 'path',
    required: true,
    schema: { type: 'string' },
    description: 'Destination path inside the box',
  })
  @ApiConsumes('application/octet-stream')
  @ApiBody({
    description: 'Raw file bytes, streamed as the request body.',
    required: true,
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({ status: 204, description: 'File uploaded' })
  async proxyFileUpload(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyFilesPath(authContext, boxId, req, res, next)
  }

  @Post(':boxId/files/bulk-upload')
  @ApiOperation({
    operationId: 'bulkUploadBoxFiles',
    summary: 'Upload multiple files to a box in one request',
    description:
      'multipart/form-data with paired files[N].path + files[N].file fields per file. ' +
      'Per-file errors are collected rather than aborting the batch. Proxied to the runner.',
  })
  @ApiConsumes('multipart/form-data')
  // No @ApiBody — files[N].path / files[N].file isn't expressible as an OpenAPI schema; description above documents the contract.
  @ApiResponse({ status: 200, description: 'All files uploaded' })
  @ApiResponse({ status: 400, description: 'Partial success — see body for uploaded + errors lists' })
  async proxyFilesBulkUpload(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      `/v1/boxes/${boxId}/files/bulk-upload`,
      req,
      res,
      next,
    )
  }

  @Post(':boxId/files/bulk-download')
  @ApiOperation({
    operationId: 'bulkDownloadBoxFiles',
    summary: 'Download multiple files from a box in one request',
    description:
      'JSON request {paths:[...]}. Response is multipart/form-data with boundary ' +
      'BOXLITE-FILE-BOUNDARY where each part is name="file"; filename=<path> on success ' +
      'or name="error"; filename=<path> on per-file failure. Proxied to the runner.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
      },
      required: ['paths'],
    },
  })
  @ApiResponse({ status: 200, description: 'Streamed multipart/form-data with per-file parts' })
  async proxyFilesBulkDownload(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    return this.proxyToRunner(
      authContext,
      boxId,
      `/v1/boxes/${boxId}/files/bulk-download`,
      req,
      res,
      next,
    )
  }

  // Shared body for the /files Get + Put proxies. Pulls the original
  // query string off the inbound URL so ?path=... rides through unchanged.
  private async proxyFilesPath(
    authContext: OrganizationAuthContext,
    boxId: string,
    req: Request,
    res: Response,
    next: NextFunction,
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
  @ApiExcludeEndpoint()
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
