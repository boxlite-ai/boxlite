/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubRequestError } from './github'
import { ScaleSetPollError } from './scale-set-poll-error'

type Stage =
  | 'session'
  | 'authority'
  | 'resolve'
  | 'open'
  | 'persist-target'
  | 'capacity'
  | 'poll'
  | 'statistics'
  | 'reserve'
  | 'acquire'
  | 'ack'
  | 'close'

interface SetContext {
  scope: string
  organization: string
  installation: number
  label: string
  scaleSet: number | null
  messageId: number | null
}
type Progress =
  | { event: 'ci-scale-set-session-opened'; assigned: number; acquired?: number }
  | { event: 'ci-scale-set-offers-skipped'; reason: 'capacity' | 'creation-backoff' | 'no-match' | 'no-slot' }
  | { event: 'ci-scale-set-poll-started'; capacity: number }
  | { event: 'ci-scale-set-message-received'; offered: number; capacity: number; assigned?: number; held: number }
  | { event: 'ci-scale-set-first-reservation'; allocation: string }
  | { event: 'ci-scale-set-acquired'; attempted: number; accepted: number }

export type ScaleSetEvent = SetContext & Progress & { level: 'info' }
export type ScaleSetFailure = SetContext &
  Partial<ScaleSetPollError['details']> & { stage: Stage; httpStatus?: number; retryAt?: number }

/** One context per active session. On rejection keep the innermost operation for the session's error report. */
export class ScaleSetDiagnostics {
  private stage: Stage = 'session'
  constructor(
    readonly context: SetContext,
    private readonly observe?: (event: ScaleSetEvent) => void,
  ) {}
  async during<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
    const parent = this.stage
    this.stage = stage
    const result = await work()
    this.stage = parent
    return result
  }
  emit(progress: Progress): void {
    this.observe?.({ ...this.context, level: 'info', ...progress })
  }
  failure(error: unknown, stage = this.stage): ScaleSetFailure {
    return {
      ...this.context,
      stage,
      ...(error instanceof ScaleSetPollError ? error.details : {}),
      ...(error instanceof GitHubRequestError && error.status !== undefined ? { httpStatus: error.status } : {}),
    }
  }
}
