/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsIn, IsInt, IsNotEmpty, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator'

/**
 * What a domain routes to, in the box API's snake_case. `type` names the kind
 * of target and decides which fields follow. App targets are reserved and
 * binding them is explicitly refused by the controller. `box` takes a box id
 * or name, resolved the way every other box route resolves one.
 */
export class DomainTargetDto {
  @IsIn(['box', 'app'], { message: 'type must be "box" or "app"' })
  type: 'box' | 'app'

  @ValidateIf((target: DomainTargetDto) => target.type === 'box')
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  box?: string

  @ValidateIf((target: DomainTargetDto) => target.type === 'box')
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number

  @ValidateIf((target: DomainTargetDto) => target.type === 'app')
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  app?: string
}
