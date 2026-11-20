import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { RunnerContextDecorator } from '../../common/decorators/runner-context.decorator'
import type { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { CompleteCreateJobService } from '../services/complete-create-job.service'

@ApiExcludeController()
@Controller('jobs/complete-outbound')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
export class CompleteCreateJobController {
  constructor(private readonly jobs: CompleteCreateJobService) {}

  @Post('claim')
  @HttpCode(200)
  async claim(@RunnerContextDecorator() runner: RunnerContext, @Headers('x-boxlite-complete-lease') lease?: string) {
    return { request: await this.jobs.claim(runner, lease) }
  }

  @Post(':jobId/receipt')
  @HttpCode(204)
  async receipt(
    @RunnerContextDecorator() runner: RunnerContext,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() proof: unknown,
    @Headers('x-boxlite-complete-lease') lease?: string,
  ): Promise<void> {
    await this.jobs.accept(runner, lease, jobId, proof)
  }
}
