/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsIn, IsOptional, IsString, Matches } from 'class-validator'
import { SUBSCRIPTION_PLAN_CODES, SubscriptionPlanCode } from './subscription.types'

const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d{1,9})?$/

@ApiSchema({ name: 'SubscriptionPlanRequest' })
export class SubscriptionPlanRequestDto {
  @ApiProperty({ enum: SUBSCRIPTION_PLAN_CODES })
  @IsIn(SUBSCRIPTION_PLAN_CODES)
  planCode: SubscriptionPlanCode
}

@ApiSchema({ name: 'UserResourceMultipliersRequest' })
export class UserResourceMultipliersRequestDto {
  @ApiPropertyOptional({ type: String, example: '1.25' })
  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL, { message: 'cpu multiplier must be a non-negative decimal with at most 9 places' })
  cpu?: string

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL, { message: 'memory multiplier must be a non-negative decimal with at most 9 places' })
  mem?: string

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL, { message: 'disk multiplier must be a non-negative decimal with at most 9 places' })
  disk?: string

  @ApiPropertyOptional({ type: String, example: '1' })
  @IsOptional()
  @IsString()
  @Matches(NON_NEGATIVE_DECIMAL, { message: 'gpu multiplier must be a non-negative decimal with at most 9 places' })
  gpu?: string
}
