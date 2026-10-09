/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Matches } from 'class-validator'
import { DIGEST_PATTERN } from '../../image/utils/image-ref.util'

/**
 * Where to point a tag, in the box API's snake_case. The box API's versions
 * carry no id, so the version is named by its manifest digest; which image it
 * belongs to is the route's.
 */
export class MoveTagDto {
  @Matches(DIGEST_PATTERN, { message: 'digest must be sha256: followed by 64 lowercase hex digits' })
  digest: string
}
