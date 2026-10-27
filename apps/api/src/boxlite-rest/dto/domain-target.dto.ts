/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsIn, IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator'

/**
 * What a domain routes to, in the box API's snake_case. `type` names the kind
 * of target and decides which fields follow; `box` is the only kind today,
 * and an `app` kind joins it without changing the route. `box` takes a box id
 * or name, resolved the way every other box route resolves one.
 */
export class DomainTargetDto {
  @IsIn(['box'], { message: 'type must be "box"' })
  type: 'box'

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  box: string

  @IsInt()
  @Min(1)
  @Max(65535)
  port: number
}
