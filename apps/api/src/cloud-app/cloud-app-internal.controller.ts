import { All, Controller, ForbiddenException, Get, NotFoundException, Param, Req, Res } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { SkipThrottle } from '@nestjs/throttler'
import type { Request, Response } from 'express'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { TypedConfigService } from '../config/typed-config.service'
import { bearer } from './engine/auth'
import { verifyState } from './engine/enduser/state'
import { CloudAppService } from './cloud-app.service'
import { cloudAppRequest, sendCloudAppResponse } from './cloud-app-http'

@Controller('internal/apps')
@ApiExcludeController()
@SkipThrottle()
export class CloudAppInternalController {
  constructor(
    private readonly apps: CloudAppService,
    private readonly config: TypedConfigService,
  ) {}

  @All(['ingress/:environmentId', 'ingress/:environmentId/{*path}'])
  async ingress(@Param('environmentId') id: string, @Req() request: Request, @Res() response: Response) {
    const original = new URL(request.originalUrl, 'http://platform.local')
    const path = original.pathname.slice(`/api/internal/apps/ingress/${id}`.length) || '/'
    const proto = this.config.get('proxy.protocol') || 'https'
    const incoming = cloudAppRequest(request, `${proto}://${request.headers.host}${path}${original.search}`)
    await sendCloudAppResponse(await this.apps.ingress(incoming, id, request), response)
  }

  @All('sv/v1/{*path}')
  async supervisor(@Req() request: Request, @Res() response: Response) {
    const token = bearer(request.headers.authorization)
    if (!token) throw new ForbiddenException('Supervisor authentication required')
    const organizationId = await this.apps.supervisorOrganization(token)
    await this.engineRequest(request, response, organizationId)
  }

  @All(['auth/start', 'auth/callback/:provider'])
  async oauth(@Req() request: Request, @Res() response: Response) {
    const url = new URL(request.originalUrl, 'http://platform.local')
    const settings = this.config.get('cloudApps')
    const state = verifyState(
      settings.sessionSecret || '',
      String(request.body?.state || url.searchParams.get('state') || ''),
    )
    const organizationId = url.pathname.endsWith('/auth/start')
      ? url.searchParams.get('organization')
      : state?.organization
    if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId))
      throw new ForbiddenException('Invalid App sign-in state')
    await this.engineRequest(request, response, organizationId)
  }

  @Get(['artifacts/:version/:file', 'sv/bin/:file', 'cli/:file'])
  async artifact(@Param('file') file: string, @Res() response: Response, @Param('version') version?: string) {
    if (
      ![
        'boxlite-app.tgz',
        'agent.md',
        'prompt-template.md',
        'supervisor-linux-amd64',
        'supervisor-linux-arm64',
        'supervisor-linux-amd64.sig',
        'supervisor-linux-arm64.sig',
      ].includes(file) ||
      (version && version !== this.config.get('cloudApps.artifactVersion'))
    )
      throw new NotFoundException()
    const path = join(this.apps.artifactDirectory, file)
    if (!existsSync(path)) throw new NotFoundException('App artifact is unavailable')
    response.setHeader(
      'content-type',
      file.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream',
    )
    response.setHeader('cache-control', 'public, max-age=300')
    await pipeline(createReadStream(path), response)
  }

  private async engineRequest(request: Request, response: Response, organizationId: string) {
    const path = request.originalUrl.slice('/api/internal/apps'.length)
    await sendCloudAppResponse(
      await this.apps.internal(cloudAppRequest(request, `http://platform.local${path}`), organizationId),
      response,
    )
  }
}
