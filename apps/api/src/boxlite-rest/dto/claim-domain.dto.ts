/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class ClaimDomainDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  name: string
}
