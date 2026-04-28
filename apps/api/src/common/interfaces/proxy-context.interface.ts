/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BaseAuthContext } from './auth-context.interface'

export interface ProxyContext extends BaseAuthContext {
  role: 'proxy'
}

export function isProxyContext(user: BaseAuthContext): user is ProxyContext {
  return 'role' in user && user.role === 'proxy'
}
