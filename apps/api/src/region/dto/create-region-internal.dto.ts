/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegionType } from '../enums/region-type.enum'

export class CreateRegionInternalDto {
  id?: string
  name: string
  enforceQuotas: boolean
  regionType: RegionType
  proxyUrl?: string | null
  sshGatewayUrl?: string | null
  snapshotManagerUrl?: string | null
}
