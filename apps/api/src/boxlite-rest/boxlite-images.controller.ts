/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, HttpException, HttpStatus, Logger, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import axios, { AxiosError } from 'axios'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { RunnerService } from '../box/services/runner.service'

/**
 * Wire-compatible with the SDK's `RestImageBackend::pull_image`
 * (`src/boxlite/src/rest/images.rs`) and the runner's
 * `BoxliteImagePullRequest` (`apps/runner/pkg/api/controllers/boxlite_images.go`).
 * Field names MUST stay in lockstep — serde / NestJS validation will
 * drop any mismatched fields silently.
 */
class ImagePullRequestDto {
  reference: string
}

class ImagePullResponseDto {
  reference: string
  config_digest: string
  layer_count: number
}

@ApiTags('BoxLite REST')
@Controller('v1/:prefix')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteImagesController {
  private readonly logger = new Logger(BoxliteImagesController.name)

  constructor(private readonly runnerService: RunnerService) {}

  /**
   * `POST /v1/{prefix}/images/pull` — pull an OCI image into a runner's
   * blob cache and return its config digest + layer count so the SDK
   * can build an image handle without a follow-up round-trip.
   *
   * Runner selection: first READY runner. This matches the e2e
   * single-runner topology; in a multi-runner deployment the caller
   * would target a specific runner via a different path. Real
   * registries can take many seconds — we bump the axios timeout to
   * 5 minutes to match the runner-side pull window.
   */
  @Post('images/pull')
  async pullImage(
    @AuthContext() _ctx: OrganizationAuthContext,
    @Body() dto: ImagePullRequestDto,
  ): Promise<ImagePullResponseDto> {
    // Tolerate non-string `reference` payloads explicitly instead of
    // calling `.trim()` on whatever the client sent (booleans, arrays,
    // numbers) and surfacing the resulting TypeError as a 500. A
    // client typing `"reference": 123` should get a clean 400.
    const rawReference = dto?.reference
    if (typeof rawReference !== 'string') {
      throw new HttpException('reference must be a string', HttpStatus.BAD_REQUEST)
    }
    const reference = rawReference.trim()
    if (!reference) {
      throw new HttpException('reference is required', HttpStatus.BAD_REQUEST)
    }

    const runners = await this.runnerService.findAllReady()
    if (!runners.length) {
      throw new HttpException('no ready runner is available', HttpStatus.SERVICE_UNAVAILABLE)
    }
    const runner = runners[0]
    const targetUrl = runner.apiUrl || runner.proxyUrl
    if (!targetUrl) {
      throw new HttpException('runner endpoint not configured', HttpStatus.SERVICE_UNAVAILABLE)
    }

    try {
      const res = await axios.post<ImagePullResponseDto>(
        `${targetUrl}/v1/images/pull`,
        { reference },
        {
          headers: {
            Authorization: `Bearer ${runner.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 5 * 60 * 1000,
        },
      )
      return res.data
    } catch (err: any) {
      const axiosErr = err as AxiosError<{ error?: string }>
      if (axiosErr.response) {
        const status = axiosErr.response.status
        const message = axiosErr.response.data?.error ?? axiosErr.message
        throw new HttpException({ error: message }, status)
      }
      this.logger.error(`images.pull(${reference}) failed: ${err.message}`)
      throw new HttpException(`pull failed: ${err.message}`, HttpStatus.BAD_GATEWAY)
    }
  }
}
