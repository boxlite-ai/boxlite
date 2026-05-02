/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'ToolboxProxyUrl' })
export class ToolboxProxyUrlDto {
  @ApiProperty({
    description: 'The toolbox proxy URL for the sandbox',
    example: 'https://proxy.app.boxlite.io/toolbox',
  })
  url: string

  constructor(url: string) {
    this.url = url
  }
}
