/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from './job-type.enum'

describe('JobType', () => {
  it('exposes only job types with an active producer and runner handler', () => {
    expect(Object.values(JobType)).toEqual([
      'CREATE_BOX',
      'START_BOX',
      'STOP_BOX',
      'DESTROY_BOX',
      'EXPORT_BOX',
      'IMPORT_BOX',
      'ROLLBACK_EXPORT_BOX',
      'ROLLBACK_IMPORT_BOX',
      'DISCARD_EXPORTED_BOX',
    ])
  })
})
