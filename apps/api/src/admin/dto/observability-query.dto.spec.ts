/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { validate } from 'class-validator'
import { AdminObservabilityLogsQueryParamsDto } from './observability-query.dto'

describe('AdminObservabilityQueryParamsDto', () => {
  it('allows callers to omit from/to so the API can apply the default lookback window', async () => {
    const query = new AdminObservabilityLogsQueryParamsDto()
    query.limit = 5

    const errors = await validate(query)

    expect(errors.map((error) => error.property)).not.toContain('from')
    expect(errors.map((error) => error.property)).not.toContain('to')
  })

  it('accepts userId as an admin observability correlation filter', async () => {
    const query = new AdminObservabilityLogsQueryParamsDto()
    query.userId = 'user-1'

    const errors = await validate(query)

    expect(errors.map((error) => error.property)).not.toContain('userId')
  })
})
