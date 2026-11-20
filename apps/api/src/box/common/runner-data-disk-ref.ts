/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Identifies the cloud data disk carrying a runner's `BOXLITE_HOME` filesystem,
 * as reported by the runner itself in each healthcheck. The runner sends the
 * identity only while its own check confirms the device actually carries the
 * BoxLite home, and a heartbeat without one clears the stored identity — the
 * runner's report is the source of truth for whether a disk exists to grow.
 */
export interface RunnerDataDiskRef {
  /** Cloud provider owning the disk; `gcp` is the only writer today. */
  provider: string
  project: string
  zone: string
  /** Disk name inside the project/zone, not a full resource path. */
  diskName: string
  /**
   * The backend behind the identity (`hyperdisk_balanced`, `filestore`, ...).
   * Optional: binaries predating the field never send it, and the API then
   * assumes hyperdisk_balanced — the only type infra provisions today — so a
   * rolling upgrade never drops a live runner out of expansion coverage.
   */
  diskType?: string
}

export function isGcpDataDiskRef(ref: RunnerDataDiskRef | null | undefined): ref is RunnerDataDiskRef {
  return !!ref && ref.provider === 'gcp' && !!ref.project && !!ref.zone && !!ref.diskName
}

/**
 * Whether the runner's data disk supports online capacity growth through the
 * block-disk expansion controller. The capability rides on the disk type, not
 * just the provider: a GCP Filestore instance shares the provider but has no
 * block device and a different resize path entirely, so it is excluded even
 * though its ref parses the same shape. The gate runs ahead of the gray
 * release switch — when it answers false, no amount of enabling matters.
 */
const EXPANDABLE_DISK_TYPES = new Set(['hyperdisk_balanced'])

export function isDiskCapacityExpandable(ref: RunnerDataDiskRef | null | undefined): ref is RunnerDataDiskRef {
  if (!isGcpDataDiskRef(ref)) return false
  // `||` on purpose: the Go client serializes an unset optional string as an
  // empty JSON string, so `??` would keep that empty value and wrongly drop a
  // live runner out of expansion coverage.
  const diskType = ref.diskType || 'hyperdisk_balanced'
  return EXPANDABLE_DISK_TYPES.has(diskType)
}
