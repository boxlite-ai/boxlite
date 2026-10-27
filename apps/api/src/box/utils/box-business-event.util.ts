/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Context } from '../../common/context/context'
import { recordBusinessEvent } from '../../common/utils/business-event.util'
import { JobStatus } from '../enums/job-status.enum'

// Box events record their request where it is accepted (BoxService, the
// auto-stop and auto-delete crons) and their outcome where the runner reports
// it (JobStateHandler), so their two halves cannot share one call.
type BoxEventName = 'box.create' | 'box.stop' | 'box.delete'

export function recordBoxRequested(name: BoxEventName, boxId: string, ctx: Context): void {
  recordBusinessEvent({ name, outcome: 'requested', correlationId: boxId, ctx })
}

/** A claimed warm-pool box is already started, so its request and success commit together. */
export function recordWarmPoolClaim(boxId: string, ctx: Context): void {
  recordBoxRequested('box.create', boxId, ctx)
  recordBusinessEvent({ name: 'box.create', outcome: 'success', correlationId: boxId, ctx })
}

/**
 * Records the outcome of a finished box job. Call it only after the box row
 * reflecting that outcome has been written, and only for COMPLETED or FAILED jobs.
 */
export function recordBoxJobOutcome(name: BoxEventName, jobStatus: JobStatus, boxId: string): void {
  if (jobStatus === JobStatus.COMPLETED) {
    recordBusinessEvent({ name, outcome: 'success', correlationId: boxId })
    return
  }
  recordBusinessEvent({ name, outcome: 'exception', correlationId: boxId, exceptionType: 'runner_job_failed' })
}
