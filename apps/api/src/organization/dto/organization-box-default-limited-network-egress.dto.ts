/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'OrganizationBoxDefaultLimitedNetworkEgress' })
export class OrganizationBoxDefaultLimitedNetworkEgressDto {
  @ApiProperty({
    description: 'Box default limited network egress',
  })
  boxDefaultLimitedNetworkEgress: boolean
}
