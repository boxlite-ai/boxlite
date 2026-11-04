/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

/** Runtime configuration only. GitHub JIT credentials are delivered after boot. */
export interface WorkerLaunch {
  name: string
  image: string
  cpus: number
  memoryMiB: number
  entrypoint: string[]
}

export interface WorkerState {
  box_id: string
  status: string
  exit_code?: number | null
}

/** Host adapters use this marker only for a known original Box ID under verified original authority. */
export class ConfirmedWorkerAbsent extends Error {
  readonly confirmedBoxAbsent = true
  constructor() {
    super('Original CI Box is confirmed absent')
  }
}

/** A trusted host recorded that this exact creation operation produced no Box. */
export class ConfirmedWorkerCreationRejected extends Error {
  constructor(readonly rejectedCreationEffect: string) {
    super('Original CI Box creation was definitively rejected')
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(rejectedCreationEffect))
      throw new Error('Original CI creation operation required')
  }
}

/**
 * A host binds this capability to an original execution scope before injection.
 * The shared controller never supplies a tenant, runner endpoint or API key.
 * Missing ownership metadata must remain an error, not confirmed Box absence.
 */
export interface WorkerExecutor {
  create(launch: WorkerLaunch): Promise<WorkerState>
  get(name: string): Promise<WorkerState>
  stop(name: string): Promise<void>
  remove(name: string): Promise<void>
  deliverJit(name: string, configuration: string, signal?: AbortSignal): Promise<void>
}
