/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BOX_ID_LENGTH, BOX_ID_REGEX, generateBoxId } from './box-id.util'

describe('box ID utilities', () => {
  it('generates 12-character Base62 public box IDs', () => {
    const boxId = generateBoxId()

    expect(boxId).toHaveLength(BOX_ID_LENGTH)
    expect(boxId).toMatch(BOX_ID_REGEX)
  })
})
