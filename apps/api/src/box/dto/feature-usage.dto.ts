/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator'
import { BOX_ID_REGEX } from '../utils/box-id.util'

export const FEATURE_USAGE_KINDS = ['ssh', 'tunnel_connection', 'tunnel_request'] as const

export class FeatureUsageEventDto {
  @IsUUID()
  id: string

  @IsString()
  @Matches(BOX_ID_REGEX)
  boxId: string

  @IsIn(FEATURE_USAGE_KINDS)
  kind: (typeof FEATURE_USAGE_KINDS)[number]

  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  occurredAt: string
}

export class FeatureUsageBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FeatureUsageEventDto)
  events: FeatureUsageEventDto[]
}
