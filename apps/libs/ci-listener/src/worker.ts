/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

export const DEFAULT_WORKER_DISK_GIB = 10

/** Runtime configuration only. GitHub JIT credentials are delivered after boot. */
export interface WorkerResources {
  cpus: number
  memoryMiB: number
  diskGiB?: number
}

export function validateWorkerResources(resources: WorkerResources): void {
  const disk = resources.diskGiB ?? DEFAULT_WORKER_DISK_GIB
  if (
    !Number.isSafeInteger(resources.cpus) ||
    resources.cpus < 1 ||
    resources.cpus > 16 ||
    !Number.isSafeInteger(resources.memoryMiB) ||
    resources.memoryMiB < 128 ||
    resources.memoryMiB > 131072 ||
    !Number.isSafeInteger(disk) ||
    disk < 1 ||
    !Number.isSafeInteger(disk * 1024 ** 3)
  )
    throw new Error('Invalid CI worker resources')
}

export interface WorkerLaunch extends WorkerResources {
  name: string
  image: string
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
