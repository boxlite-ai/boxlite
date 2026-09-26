/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, ForbiddenException, Get, NotFoundException, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { RunnerAuthGuard } from '../../auth/runner-auth.guard'
import { RunnerContextDecorator } from '../../common/decorators/runner-context.decorator'
import { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { RegistryCredentialLookupDto, RunnerRegistryCredentialDto } from '../dto/runner-registry-credential.dto'
import { RegistryCredentialService } from '../services/registry-credential.service'

/**
 * The registry proxy's view of the credentials: it calls with the runner key
 * it already checked, and learns which login to use and where its password is.
 * The password itself is readable by the proxy's own account and nobody
 * else's.
 *
 * A runner may ask only about an organization whose box it hosts, and the
 * proxy spends a login only on that answer — see `runnerServes` for why a
 * runner key alone is not enough.
 *
 * No `AuthenticatedRateLimitGuard`, as on the job routes: the caller is the
 * proxy on a runner's behalf, which keeps every answer here — a login, "none"
 * and a refusal — for a minute per runner, and meters each runner's pulls.
 */
@ApiTags('runners')
@Controller('runners/me/registry-credentials')
@UseGuards(CombinedAuthGuard, RunnerAuthGuard)
@ApiBearerAuth()
export class RunnerRegistryCredentialController {
  constructor(private readonly credentials: RegistryCredentialService) {}

  @Get()
  @ApiOperation({
    summary: 'Find the registry credential a pull uses',
    operationId: 'getRegistryCredentialForAuthenticatedRunner',
  })
  @ApiResponse({ status: 200, type: RunnerRegistryCredentialDto })
  @ApiResponse({ status: 403, description: 'The runner hosts no box of that organization' })
  // 404 for "none" rather than another 403, so the proxy can tell a pull with
  // no login, which goes on anonymously, from one it must refuse.
  @ApiResponse({ status: 404, description: 'The organization has no credential for this repository' })
  async find(
    @RunnerContextDecorator() runner: RunnerContext,
    @Query() lookup: RegistryCredentialLookupDto,
  ): Promise<RunnerRegistryCredentialDto> {
    if (!(await this.credentials.runnerServes(runner.runnerId, lookup.organizationId))) {
      throw new ForbiddenException('This runner hosts no box of that organization')
    }
    const credential = await this.credentials.findForRepository(lookup.organizationId, lookup.host, lookup.repository)
    if (!credential) {
      throw new NotFoundException(`No registry credential for ${lookup.host}/${lookup.repository}`)
    }
    return RunnerRegistryCredentialDto.from(credential)
  }
}
