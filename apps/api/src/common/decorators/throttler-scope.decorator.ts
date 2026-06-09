/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SetMetadata } from '@nestjs/common'

export const THROTTLER_SCOPE_KEY = 'throttler:scope'

/**
 * Marks a route or controller with specific throttler scopes.
 * Only the specified throttlers will be applied to this route.
 * The 'authenticated' throttler always applies to authenticated routes.
 *
 * @example
 * // Apply box-create throttler
 * @ThrottlerScope('box-create')
 * @Post()
 * createBox() {}
 *
 * @example
 * // Apply multiple throttlers
 * @ThrottlerScope('box-create', 'box-lifecycle')
 * @Post()
 * createAndStart() {}
 */
export const ThrottlerScope = (...scopes: string[]) => SetMetadata(THROTTLER_SCOPE_KEY, scopes)
