import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { RunnerContextDecorator } from '../../common/decorators/runner-context.decorator'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { ProtectedBootstrapService } from '../services/protected-bootstrap.service'
import { isBoxId } from '../utils/box-id.util'
import { validate as isUuid } from 'uuid'

@ApiExcludeController()
@Controller('runners/protected-bootstrap')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
export class ProtectedBootstrapController {
  constructor(private readonly bootstrap: ProtectedBootstrapService) {}

  @Get('identity')
  async identity(@RunnerContextDecorator() context: RunnerContext, @Headers('authorization') authorization?: string) {
    return this.bootstrap.identity(context.runnerId, authorization)
  }

  @Post('authorize')
  @HttpCode(200)
  async authorize(
    @RunnerContextDecorator() context: RunnerContext,
    @Headers('authorization') authorization: string | undefined,
    @Body() request: Parameters<ProtectedBootstrapService['authorize']>[2],
  ) {
    if (!request || typeof request.box_id !== 'string' || !(isBoxId(request.box_id) || isUuid(request.box_id))) {
      throw new BadRequestException('Invalid protected bootstrap Box')
    }
    return this.bootstrap.authorize(context.runnerId, authorization, request)
  }
}
