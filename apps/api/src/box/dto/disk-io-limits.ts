/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Disk I/O ceilings for a box: bandwidth in bytes per second and operations
 * per second, each per direction. An undefined field is unlimited.
 *
 * Internal (camelCase) shape shared by the create DTO, the Box entity's jsonb
 * column, and the runner payload — the runner's `DiskIoLimitsDTO` uses the
 * same field names, so the object is forwarded as-is. The REST boundary maps
 * from the snake_case `disk_io` of openapi/box.openapi.yaml.
 */
export interface DiskIoLimits {
  readBps?: number
  writeBps?: number
  readIops?: number
  writeIops?: number
}
