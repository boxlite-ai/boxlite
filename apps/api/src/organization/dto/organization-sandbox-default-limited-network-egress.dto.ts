/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'OrganizationSandboxDefaultLimitedNetworkEgress' })
export class OrganizationSandboxDefaultLimitedNetworkEgressDto {
  @ApiProperty({
    description: 'Sandbox default limited network egress',
  })
  sandboxDefaultLimitedNetworkEgress: boolean
}
