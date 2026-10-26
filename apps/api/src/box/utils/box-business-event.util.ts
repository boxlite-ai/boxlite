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
type BoxEventName = 'box.create' | 'box.start' | 'box.stop' | 'box.delete'

/** The box an event is about; its organization travels with every record of it. */
export type BoxRef = { id: string; organizationId: string }

export function recordBoxRequested(name: BoxEventName, box: BoxRef, ctx: Context): void {
  recordBusinessEvent({ name, outcome: 'requested', correlationId: box.id, organizationId: box.organizationId, ctx })
}

/** A claimed warm-pool box is already started, so its request and success commit together. */
export function recordWarmPoolClaim(box: BoxRef, ctx: Context): void {
  recordBoxRequested('box.create', box, ctx)
  recordBusinessEvent({
    name: 'box.create',
    outcome: 'success',
    correlationId: box.id,
    organizationId: box.organizationId,
    ctx,
  })
}

/**
 * Records the outcome of a finished box job. Call it only after the box row
 * reflecting that outcome has been written, and only for COMPLETED or FAILED jobs.
 */
export function recordBoxJobOutcome(name: BoxEventName, jobStatus: JobStatus, box: BoxRef): void {
  const event = { name, correlationId: box.id, organizationId: box.organizationId }
  if (jobStatus === JobStatus.COMPLETED) {
    recordBusinessEvent({ ...event, outcome: 'success' })
    return
  }
  recordBusinessEvent({ ...event, outcome: 'exception', exceptionType: 'runner_job_failed' })
}
