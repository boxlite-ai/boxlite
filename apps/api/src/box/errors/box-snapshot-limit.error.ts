/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

export const BOX_SNAPSHOT_LIMIT_EXCEEDED_CODE = 'resource_exhausted'
export const BOX_SNAPSHOT_ADMISSION_UNAVAILABLE_CODE = 'upstream_unavailable'

export class BoxSnapshotLimitExceededError extends HttpException {
  constructor(keptCount: number, limit: number) {
    super(
      {
        message: `Organization snapshot limit reached: ${keptCount} of ${limit} snapshots are kept`,
        code: BOX_SNAPSHOT_LIMIT_EXCEEDED_CODE,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    )
    this.name = 'BoxSnapshotLimitExceededError'
  }
}

export class BoxSnapshotAdmissionUnavailableError extends HttpException {
  constructor() {
    super(
      {
        message: 'Snapshot creation is busy for this organization; retry the request',
        code: BOX_SNAPSHOT_ADMISSION_UNAVAILABLE_CODE,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    )
    this.name = 'BoxSnapshotAdmissionUnavailableError'
  }
}
