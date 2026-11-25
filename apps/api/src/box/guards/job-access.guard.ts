/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, CanActivate, ExecutionContext, NotFoundException } from '@nestjs/common'
import { BaseAuthContext } from '../../common/interfaces/auth-context.interface'
import { JobService } from '../services/job.service'
import { isRunnerContext } from '../../common/interfaces/runner-context.interface'

@Injectable()
export class JobAccessGuard implements CanActivate {
  constructor(private readonly jobService: JobService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest()
    const jobId: string = request.params.jobId || request.params.id

    // TODO: initialize authContext safely
    const authContext: BaseAuthContext = request.user

    const job = await this.jobService.findOne(jobId)
    if (!job || !isRunnerContext(authContext) || authContext.runnerId !== job.runnerId) {
      throw new NotFoundException('Job not found')
    }
    return true
  }
}
