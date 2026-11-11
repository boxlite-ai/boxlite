/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CredentialSource, ListenerCredentials } from '../credentials'
import { GitHubRequestError } from '../github'
import { readRepositoryJobs } from '../job-reader'
import { WorkflowJob } from '../jobs'
import { LeaseLost, StateConflict } from '../state/database'
import type { ListenerState } from '../state/store'
import { RepositoryScanQueue, ScanClaim } from './queue'

export interface RepositoryScanSession {
  queued(signal: AbortSignal): Promise<WorkflowJob[]>
  publish(jobs: readonly WorkflowJob[], signal: AbortSignal): Promise<void>
  close(): Promise<void>
}
export interface RepositoryScannerOptions {
  queue: RepositoryScanQueue
  claim: ScanClaim
  source: CredentialSource
  credentials?: Pick<ListenerState, 'commit'>
  authorize(signal?: AbortSignal): Promise<void>
  publish(jobs: readonly WorkflowJob[], signal: AbortSignal): Promise<void>
}

/** GitHub jobs only: no worker, runner-registration or capacity capability. */
export class GitHubRepositoryScanner implements RepositoryScanSession {
  private readonly credentials: ListenerCredentials
  private readonly claim: ScanClaim
  constructor(private readonly options: RepositoryScannerOptions) {
    this.claim = structuredClone(options.claim)
    this.credentials = new ListenerCredentials(
      options.credentials ?? options.queue.credentials(this.claim),
      this.claim,
      'scan/' + this.claim.id,
      options.source,
    )
  }
  queued(signal: AbortSignal): Promise<WorkflowJob[]> {
    return readRepositoryJobs(
      this.claim.scope,
      this.credentials,
      async (signal) => {
        signal?.throwIfAborted()
        await this.options.authorize(signal)
        await this.options.queue.check(this.claim)
        signal?.throwIfAborted()
      },
      this.claim.repository,
      (jobs) => jobs.queued(signal),
      signal,
    )
  }
  publish(jobs: readonly WorkflowJob[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return this.options.publish(jobs, signal)
  }
  close(): Promise<void> {
    return this.credentials.close()
  }
}

interface CompensationOptions {
  queue: RepositoryScanQueue
  open(claim: ScanClaim, signal: AbortSignal): Promise<RepositoryScanSession>
  report(error: unknown, operation: string): void
  wake(): void
  tickMs: number
  intervalMs: number
}

/** Each replica owns two immediate-execution lanes; PostgreSQL coordinates their repository leases. */
export class RepositoryCompensation {
  private readonly retiring = new Map<number, RepositoryScanSession>()
  constructor(private readonly options: CompensationOptions) {}
  async run(signal: AbortSignal): Promise<void> {
    const results = await Promise.allSettled([this.lane(0, signal), this.lane(1, signal)])
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, 'Compensation credential retirement is incomplete')
  }
  private async lane(index: number, signal: AbortSignal): Promise<void> {
    const owner = randomUUID()
    try {
      while (!signal.aborted) {
        try {
          await this.retire(index)
          const claim = await this.options.queue.claim(owner)
          if (claim) await this.scan(index, claim, signal)
          await this.options.queue.collect()
        } catch (error) {
          if (!signal.aborted && !(error instanceof LeaseLost) && !(error instanceof StateConflict))
            this.options.report(error, 'compensation')
        }
        if (!signal.aborted) {
          try {
            await delay(this.options.tickMs, undefined, { signal })
          } catch (error) {
            if (!signal.aborted) throw error
          }
        }
      }
    } finally {
      await this.retire(index)
    }
  }
  private async scan(index: number, claim: ScanClaim, external: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([external, AbortSignal.timeout(45000)])
    let reader: RepositoryScanSession | undefined,
      success = false,
      failure: unknown
    try {
      reader = await this.options.open(structuredClone(claim), signal)
      this.retiring.set(index, reader)
      const jobs = await reader.queued(signal)
      for (let offset = 0; offset < jobs.length; offset += 50) {
        signal.throwIfAborted()
        await reader.publish(jobs.slice(offset, offset + 50), signal)
        this.options.wake()
      }
      signal.throwIfAborted()
      success = true
    } catch (error) {
      failure = error
    }
    try {
      await this.retire(index)
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Scan and credential retirement failed') : error
      success = false
    }
    try {
      await this.options.queue.finish(claim, {
        success,
        intervalMs: this.options.intervalMs,
        retryAt: this.retryAt(failure),
      })
    } catch (error) {
      if (!(error instanceof LeaseLost) && !(error instanceof StateConflict)) throw error
    }
    if (failure) throw failure
  }
  private retryAt(error: unknown): number | undefined {
    if (error instanceof AggregateError) {
      const values = error.errors
        .map((entry) => this.retryAt(entry))
        .filter((value): value is number => value !== undefined)
      return values.length ? Math.max(...values) : undefined
    }
    if (!(error instanceof GitHubRequestError)) return undefined
    if (error.status === 429) return Math.max(Date.now() + 60000, error.retryAt ?? 0)
    return error.status === 403 ? error.retryAt : undefined
  }
  private async retire(index: number): Promise<void> {
    const reader = this.retiring.get(index)
    if (!reader) return
    await reader.close()
    this.retiring.delete(index)
  }
}
