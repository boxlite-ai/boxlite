/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'SupportedBoxImage' })
export class SupportedBoxImageDto {
  @ApiProperty({
    description: 'Stable image option ID shown by the dashboard',
    example: 'python',
  })
  id: string

  @ApiProperty({
    description: 'Display name for the supported image',
    example: 'Python',
  })
  name: string

  @ApiProperty({
    description: 'Pinned OCI image reference accepted by box creation',
    example:
      'ghcr.io/boxlite-ai/boxlite-agent-python@sha256:80d562a57f4bc12def4e54dbdb9e7d26d3268fe0767a2955ab5ad718041145d6',
  })
  ref: string

  @ApiProperty({
    description: 'Whether this image is used when create omits an image',
    example: false,
  })
  isDefault: boolean
}
