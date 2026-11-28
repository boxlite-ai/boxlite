/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxVolume, BoxVolumeFilestoreRef } from '../dto/box.dto'
import { Runner } from '../entities/runner.entity'

/** Atomic contract for readOnly plus subpath; half-support is unsupported. */
export const VOLUME_MOUNT_OPTIONS_CAPABILITY = 'volume-mount-options'

type RunnerVolume = {
  volumeId: string
  mountPath: string
  subpath?: string
  readOnly?: boolean
  filestore?: BoxVolumeFilestoreRef
}

/**
 * One mapping from the persisted mount contract to every Runner protocol.
 *
 * Create, start metadata, and recovery must all read this helper: a field
 * mapped in one path but omitted in another silently changes mount semantics.
 */
export function toRunnerVolumes(volumes: BoxVolume[] | undefined): RunnerVolume[] | undefined {
  return volumes?.map((volume) => ({
    volumeId: volume.volumeId,
    mountPath: volume.mountPath,
    subpath: volume.subpath,
    readOnly: volume.readOnly,
    ...(volume.filestore ? { filestore: volume.filestore } : {}),
  }))
}

/**
 * Only readOnly is new on the Runner wire. A subpath alone was already valid
 * before mount options: old Runners joined it into the mount path, and gating
 * it on the new capability would turn an API-first fleet rollout into an
 * outage for otherwise unchanged boxes.
 */
export function requiresVolumeMountOptions(volumes: BoxVolume[] | undefined): boolean {
  return !!volumes?.some((volume) => volume.readOnly === true)
}

export function runnerSupportsVolumeMountOptions(runner: Runner): boolean {
  return runner.capabilities?.includes(VOLUME_MOUNT_OPTIONS_CAPABILITY) === true
}

type CapabilityReporter = {
  runnerInfo(signal?: AbortSignal): Promise<{ capabilities?: string[] }>
}

export type VolumeMountOptionsProbe =
  | { status: 'supported' }
  | { status: 'unsupported' }
  | { status: 'unavailable'; error: Error }

const DEFAULT_VOLUME_MOUNT_OPTIONS_PROBE_TIMEOUT_MS = 1_000

/**
 * Ask the Runner for its current capability without letting a hung /info call
 * hold a Box lifecycle action past its lock. An unavailable answer is distinct
 * from an explicit "unsupported": the former is retryable, while the latter is
 * a deterministic admission failure.
 */
export async function probeVolumeMountOptions(
  adapter: CapabilityReporter,
  timeoutMs?: number,
): Promise<VolumeMountOptionsProbe> {
  const bound = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_VOLUME_MOUNT_OPTIONS_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, bound)
  const timeout = new Promise<never>((_, reject) => {
    timer.unref?.()
    controller.signal.addEventListener('abort', () => {
      reject(new Error(`runner mount-options probe timed out after ${bound}ms`))
    })
  })

  try {
    const info = await Promise.race([adapter.runnerInfo(controller.signal), timeout])
    return info.capabilities?.includes(VOLUME_MOUNT_OPTIONS_CAPABILITY) === true
      ? { status: 'supported' }
      : { status: 'unsupported' }
  } catch (caught) {
    const source = caught instanceof Error ? caught : new Error(String(caught))
    const error = timedOut ? new Error(`runner mount-options probe timed out after ${bound}ms`) : source
    return { status: 'unavailable', error }
  } finally {
    clearTimeout(timer)
  }
}
