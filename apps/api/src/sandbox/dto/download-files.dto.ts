/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'DownloadFiles' })
export class DownloadFilesDto {
  @ApiProperty({
    description: 'List of remote file paths to download',
    type: [String],
  })
  paths: string[]
}
