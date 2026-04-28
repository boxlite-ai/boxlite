/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegistryType } from '../enums/registry-type.enum'

export class CreateDockerRegistryInternalDto {
  name: string
  url: string
  username: string
  password: string
  project?: string
  registryType: RegistryType
  isDefault?: boolean
  regionId?: string | null
}
