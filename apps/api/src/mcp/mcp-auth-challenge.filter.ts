/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArgumentsHost, Catch, ExceptionFilter, UnauthorizedException } from '@nestjs/common'
import { bearerAuthChallengeResponse, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server'
import type { Response } from 'express'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'
import { McpAuthMetadata } from './mcp-auth-metadata'

/**
 * Adds the RFC 6750 bearer challenge to the MCP endpoint's 401s, naming the
 * Protected Resource Metadata so a host without a token can find where to sign in.
 *
 * The answer itself stays the global filter's, so failed-auth tracking and its
 * throttling still apply.
 */
@Catch(UnauthorizedException)
export class McpAuthChallengeFilter implements ExceptionFilter {
  private readonly challenge: string
  private readonly answer: AllExceptionsFilter

  constructor(metadata: McpAuthMetadata, failedAuthTracker: FailedAuthTrackerService) {
    // The SDK formats its challenges only inside a response; reusing it keeps this
    // header in the same form as the SDK's own scope challenges.
    const sdkAnswer = bearerAuthChallengeResponse(
      new OAuthError(OAuthErrorCode.InvalidToken, 'Missing or invalid access token'),
      { resourceMetadataUrl: metadata.url },
    )
    this.challenge = sdkAnswer.headers.get('WWW-Authenticate') ?? 'Bearer'
    this.answer = new AllExceptionsFilter(failedAuthTracker)
  }

  catch(exception: UnauthorizedException, host: ArgumentsHost): Promise<void> {
    host.switchToHttp().getResponse<Response>().setHeader('WWW-Authenticate', this.challenge)
    return this.answer.catch(exception, host)
  }
}
