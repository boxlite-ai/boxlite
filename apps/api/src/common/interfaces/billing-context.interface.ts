/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BaseAuthContext } from './auth-context.interface'

export interface BillingContext extends BaseAuthContext {
  role: 'billing'
}
