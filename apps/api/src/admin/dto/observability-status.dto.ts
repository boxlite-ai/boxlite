/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty } from '@nestjs/swagger'
import { OBSERVABILITY_LAYERS, ObservabilityLayer } from './observability-query.dto'

export const OBSERVABILITY_STATES = ['missing', 'configured', 'receiving', 'stale', 'error'] as const
export type ObservabilityState = (typeof OBSERVABILITY_STATES)[number]

export class AdminObservabilityBackendStatusDto {
  @ApiProperty({ description: 'Whether ClickHouse/ClickStack query configuration is present' })
  configured: boolean

  @ApiProperty({ enum: OBSERVABILITY_STATES })
  state: ObservabilityState

  @ApiProperty({ required: false })
  message?: string
}

export class AdminObservabilityLayerSignalsDto {
  @ApiProperty({ enum: OBSERVABILITY_STATES })
  logs: ObservabilityState

  @ApiProperty({ enum: OBSERVABILITY_STATES })
  traces: ObservabilityState

  @ApiProperty({ enum: OBSERVABILITY_STATES })
  metrics: ObservabilityState
}

export class AdminObservabilityLayerStatusDto {
  @ApiProperty({ enum: OBSERVABILITY_LAYERS })
  layer: ObservabilityLayer

  @ApiProperty({ enum: OBSERVABILITY_STATES })
  state: ObservabilityState

  @ApiProperty({ type: AdminObservabilityLayerSignalsDto })
  signals: AdminObservabilityLayerSignalsDto

  @ApiProperty({ required: false })
  lastSeen?: string
}

export class AdminObservabilityStatusDto {
  @ApiProperty({ type: AdminObservabilityBackendStatusDto })
  backend: AdminObservabilityBackendStatusDto

  @ApiProperty({ type: [AdminObservabilityLayerStatusDto] })
  layers: AdminObservabilityLayerStatusDto[]
}
