/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxVolume, BoxVolumeFilestoreRef } from '../dto/box.dto'
import { boxVolumeForDispatch } from './box-volume.util'
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
    ...boxVolumeForDispatch(volume),
    readOnly: volume.readOnly,
  }))
}

export function requiresVolumeMountOptions(volumes: BoxVolume[] | undefined): boolean {
  return !!volumes?.some((volume) => volume.readOnly === true || !!volume.subpath)
}

export function runnerSupportsVolumeMountOptions(runner: Runner): boolean {
  return runner.capabilities?.includes(VOLUME_MOUNT_OPTIONS_CAPABILITY) === true
}
