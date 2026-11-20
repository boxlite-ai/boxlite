// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import {
  parseFilestoreInstances as parsePlacement,
  type FilestoreInstanceConfig,
} from '../../../shared/filestore-instances'

export type { FilestoreInstanceConfig }

export interface FilestoreInstancesConfig {
  instances: FilestoreInstanceConfig[]
}

export function parseFilestoreInstances(env: NodeJS.ProcessEnv = process.env): FilestoreInstancesConfig {
  return { instances: parsePlacement(env) }
}
