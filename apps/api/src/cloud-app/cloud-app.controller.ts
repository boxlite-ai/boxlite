import { All, Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CloudAppService } from './cloud-app.service'
import { cloudAppRequest, sendCloudAppResponse } from './cloud-app-http'

@Controller('v1/:organizationId')
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class CloudAppController {
  constructor(private readonly apps: CloudAppService) {}

  @All(['apps', 'apps/{*path}'])
  async handle(@Req() request: Request, @Res() response: Response, @Param('organizationId') organizationId: string) {
    const original = new URL(request.originalUrl, 'http://platform.local')
    const path = original.pathname.slice(`/api/v1/${organizationId}`.length)
    const principal = this.apps.principal(request.user as OrganizationAuthContext, request.method, path)
    const incoming = cloudAppRequest(request, `http://platform.local/v1${path}${original.search}`)
    await sendCloudAppResponse(await this.apps.management(incoming, principal), response)
  }

  @Get('cli/version')
  async cliVersion(@Req() request: Request, @Res() response: Response) {
    const auth = request.user as OrganizationAuthContext
    const principal = this.apps.principal(auth, 'GET', '/apps')
    await sendCloudAppResponse(
      await this.apps.management(cloudAppRequest(request, 'http://platform.local/cli/version'), principal),
      response,
    )
  }
}
