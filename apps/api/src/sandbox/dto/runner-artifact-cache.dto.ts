/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class RunnerArtifactCacheDto {
  @ApiProperty({
    description: 'Runner artifact cache ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  runnerArtifactCacheId: string

  @ApiProperty({
    description: 'Runner ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  runnerId: string

  @ApiPropertyOptional({
    description: 'Runner domain',
    example: 'runner.example.com',
  })
  runnerDomain?: string

  constructor(runnerArtifactCacheId: string, runnerId: string, runnerDomain: string | null) {
    this.runnerArtifactCacheId = runnerArtifactCacheId
    this.runnerId = runnerId
    this.runnerDomain = runnerDomain ?? undefined
  }
}
