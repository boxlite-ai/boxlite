/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'

// The exception filter receives Express's matched route, including the Nest prefix.
export function isRegistrationRequest(request: Request): boolean {
  return request.method === 'POST' && request.route?.path === '/api/auth/register'
}
