/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BaseAuthContext } from './auth-context.interface'

export interface CommerceServiceContext extends BaseAuthContext {
  role: 'commerce-service'
}

export function isCommerceServiceContext(user: BaseAuthContext): user is CommerceServiceContext {
  return 'role' in user && user.role === 'commerce-service'
}
