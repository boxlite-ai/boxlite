/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { UsageController } from './usage.controller'

describe('UsageController routing', () => {
  it('mounts organization concurrency as a direct organization resource', () => {
    const getConcurrency = Object.getOwnPropertyDescriptor(UsageController.prototype, 'getConcurrency')?.value

    expect(Reflect.getMetadata(PATH_METADATA, UsageController)).toBe('organizations/:organizationId')
    expect(Reflect.getMetadata(PATH_METADATA, getConcurrency)).toBe('/concurrency')
  })
})
