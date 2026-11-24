import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { RunnerContextDecorator } from '../../common/decorators/runner-context.decorator'
import type { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { ProtectedCheckpointJobService } from '../services/protected-checkpoint-job.service'

@ApiExcludeController()
@Controller('jobs/protected-checkpoints')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
export class ProtectedCheckpointJobController {
  constructor(private readonly service: ProtectedCheckpointJobService) {}

  @Post('claim')
  @HttpCode(200)
  async claim(@RunnerContextDecorator() runner: RunnerContext, @Headers('x-boxlite-complete-lease') lease?: string) {
    return { job: await this.service.claim(runner, lease) }
  }

  @Post(':jobId/start')
  @HttpCode(204)
  async start(
    @RunnerContextDecorator() runner: RunnerContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Headers('x-boxlite-complete-lease') lease?: string,
  ) {
    await this.service.authorize(runner, lease, jobId, false)
  }

  @Post(':jobId/cleanup')
  @HttpCode(204)
  async cleanup(
    @RunnerContextDecorator() runner: RunnerContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Headers('x-boxlite-complete-lease') lease?: string,
  ) {
    await this.service.authorize(runner, lease, jobId, true)
  }

  @Post(':jobId/receipt')
  @HttpCode(204)
  async accept(
    @RunnerContextDecorator() runner: RunnerContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() proof: unknown,
    @Headers('x-boxlite-complete-lease') lease?: string,
  ) {
    await this.service.accept(runner, lease, jobId, proof)
  }
}
