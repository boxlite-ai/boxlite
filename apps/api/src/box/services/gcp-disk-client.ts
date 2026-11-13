/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, Optional } from '@nestjs/common'
import { RunnerDataDiskRef } from '../common/runner-data-disk-ref'

/** GCP rejected the resize with its throttle signal (RESOURCE_EXHAUSTED) — for this API's budget that means the per-disk resize rate limit. */
export class GcpDiskRateLimitedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GcpDiskRateLimitedError'
  }
}

export interface GcpZoneOperation {
  status: 'PENDING' | 'RUNNING' | 'DONE'
  /** Present when status is DONE and the operation failed; the raw cloud error text. */
  error?: string
}

/** The disk's provisioned-performance state as the cloud reports it (int64-as-string). */
export interface GcpDiskSnapshot {
  sizeGb?: string
  provisionedIops?: string
  provisionedThroughput?: string
}

/**
 * The provisioned-performance fields a PATCH will carry. A field is present
 * only when its proportional target differs from the disk's current value —
 * sending a same-value field is unreliable (the sibling size field has proof
 * GCP 400s on "must be larger"), so the client builds `paths` from exactly
 * these.
 */
export interface GcpDiskPerformanceFields {
  iops?: string
  throughput?: string
}

/** The surface the expansion controller needs; fakes implement exactly this in tests. */
export interface GcpDiskClientLike {
  resizeDisk(
    ref: RunnerDataDiskRef,
    sizeGb: number,
    performance?: GcpDiskPerformanceFields,
  ): Promise<{ operation: string }>
  getDisk(ref: RunnerDataDiskRef): Promise<GcpDiskSnapshot>
  getZoneOperation(ref: RunnerDataDiskRef, operation: string): Promise<GcpZoneOperation>
}

// Structural slices of the generated @google-cloud/compute clients, so tests
// can supply plain objects without dragging the generated types in.
interface DisksLike {
  update(request: {
    project: string
    zone: string
    disk: string
    diskResource: { name: string; sizeGb: string; provisionedIops?: string; provisionedThroughput?: string }
    paths: string[]
  }): Promise<{ name: string }[]>
  get(request: { project: string; zone: string; disk: string }): Promise<
    {
      sizeGb?: string | number | null
      provisionedIops?: string | number | null
      provisionedThroughput?: string | number | null
    }[]
  >
}

interface ZoneOperationsLike {
  get(request: { project: string; zone: string; operation: string }): Promise<
    { name?: string; status?: string; error?: { errors?: { code?: string; message?: string }[] } }[]
  >
}

/**
 * Thin wrapper over the two GCP Compute calls the expansion controller makes:
 * growing a disk (`disks.update`) and polling the zone operation it returns,
 * plus the read that grounds the proportional performance targets (`disks.get`).
 *
 * Three invariants live here and are pinned by tests:
 * - `paths` is always an explicit non-empty subset of the fields the body
 *   carries: `['sizeGb']`, or `['sizeGb', 'provisionedIops']`,
 *   `['sizeGb', 'provisionedThroughput']`, or all three. The v1 client also
 *   accepts `updateMask`, but it is silently ignored there — the request then
 *   goes out without `paths` as a full PATCH, which would reset
 *   provisionedIops/Throughput to defaults. Only `paths` reaches GCP as the
 *   field mask.
 * - the resource body carries the disk name. `disks.update` requires
 *   `resource.name` even though the mask only names `sizeGb`; without it GCP
 *   rejects the request outright (`Invalid value for field 'resource.name': ''`).
 * - authentication is Application Default Credentials only, like every other
 *   `@google-cloud/*` client in this API (the Cloud Run service account).
 */
@Injectable()
export class GcpDiskClient implements GcpDiskClientLike {
  private readonly logger = new Logger(GcpDiskClient.name)
  private disks?: DisksLike
  private zoneOperations?: ZoneOperationsLike

  constructor(@Optional() transport?: { disks?: DisksLike; zoneOperations?: ZoneOperationsLike }) {
    this.disks = transport?.disks
    this.zoneOperations = transport?.zoneOperations
  }

  async resizeDisk(
    ref: RunnerDataDiskRef,
    sizeGb: number,
    performance?: GcpDiskPerformanceFields,
  ): Promise<{ operation: string }> {
    // The field mask names exactly the fields the body carries. A performance
    // field joins only when its caller passed a value, so the four request
    // shapes are: size-only, size+IOPS, size+throughput, and all three —
    // never a mask that omits a carried field (that field would reset to the
    // cloud default) and never a full PATCH.
    const paths = ['sizeGb']
    const diskResource: {
      name: string
      sizeGb: string
      provisionedIops?: string
      provisionedThroughput?: string
    } = { name: ref.diskName, sizeGb: String(sizeGb) }
    if (performance?.iops !== undefined) {
      paths.push('provisionedIops')
      diskResource.provisionedIops = performance.iops
    }
    if (performance?.throughput !== undefined) {
      paths.push('provisionedThroughput')
      diskResource.provisionedThroughput = performance.throughput
    }
    let operation: { name: string } | undefined
    try {
      ;[operation] = await this.disksClient().update({
        project: ref.project,
        zone: ref.zone,
        disk: ref.diskName,
        diskResource,
        paths,
      })
    } catch (e) {
      // Map here so callers only ever see this module's error classes: a
      // rate-limit answer and a broken transport must not be confused.
      throw toExpansionClientError(e)
    }
    return { operation: operation.name }
  }

  /**
   * Reads the disk's current size and provisioned performance — the measured
   * baseline the proportional targets scale from. Values normalize to
   * strings (the SDK's gRPC path can hand back numbers/Longs) so callers see
   * int64-as-string end to end.
   */
  async getDisk(ref: RunnerDataDiskRef): Promise<GcpDiskSnapshot> {
    let disk: Awaited<ReturnType<DisksLike['get']>>[number] | undefined
    try {
      ;[disk] = await this.disksClient().get({ project: ref.project, zone: ref.zone, disk: ref.diskName })
    } catch (e) {
      throw toExpansionClientError(e)
    }
    const asString = (value: string | number | null | undefined): string | undefined =>
      value === null || value === undefined ? undefined : String(value)
    return {
      sizeGb: asString(disk?.sizeGb),
      provisionedIops: asString(disk?.provisionedIops),
      provisionedThroughput: asString(disk?.provisionedThroughput),
    }
  }

  async getZoneOperation(ref: RunnerDataDiskRef, operation: string): Promise<GcpZoneOperation> {
    let op: Awaited<ReturnType<ZoneOperationsLike['get']>>[0] | undefined
    try {
      ;[op] = await this.zoneOperationsClient().get({
        project: ref.project,
        zone: ref.zone,
        operation,
      })
    } catch (e) {
      throw toExpansionClientError(e)
    }
    if (op.error?.errors?.length) {
      return {
        status: 'DONE',
        error: op.error.errors.map((e) => `${e.code ?? 'unknown'}: ${e.message ?? ''}`).join('; '),
      }
    }
    return { status: (op.status as GcpZoneOperation['status']) ?? 'PENDING' }
  }

  private disksClient(): DisksLike {
    if (!this.disks) {
      // REST fallback: no gRPC channels on Cloud Run cold starts.
      const { DisksClient } = require('@google-cloud/compute') as { DisksClient: new (opts: unknown) => DisksLike }
      this.disks = new DisksClient({ fallback: 'rest' })
      this.logger.debug('Initialized GCP DisksClient (rest fallback)')
    }
    return this.disks
  }

  private zoneOperationsClient(): ZoneOperationsLike {
    if (!this.zoneOperations) {
      const { ZoneOperationsClient } = require('@google-cloud/compute') as {
        ZoneOperationsClient: new (opts: unknown) => ZoneOperationsLike
      }
      this.zoneOperations = new ZoneOperationsClient({ fallback: 'rest' })
      this.logger.debug('Initialized GCP ZoneOperationsClient (rest fallback)')
    }
    return this.zoneOperations
  }
}

/**
 * Maps a raw @google-cloud/compute failure to the expansion controller's error classes.
 *
 * The client runs google-gax's REST fallback, so failures arrive as GoogleError
 * objects whose `code` is a gRPC status, not the HTTP status: GCP's rate-limit
 * rejection (HTTP 429, reason rateLimitExceeded) surfaces as RESOURCE_EXHAUSTED
 * (8), while a genuine request-validation 400 surfaces as INVALID_ARGUMENT (3)
 * and must stay an unthrottled rejection. Only the throttle signal opens the
 * cooldown; matching the HTTP status instead never fires in production.
 */
export function toExpansionClientError(error: unknown): Error {
  const status = (error as { code?: number })?.code
  const message = error instanceof Error ? error.message : String(error)
  if (status === GCP_THROTTLE_GRPC_STATUS) {
    return new GcpDiskRateLimitedError(message)
  }
  return error instanceof Error ? error : new Error(message)
}

/**
 * google-gax's gRPC status for RESOURCE_EXHAUSTED — the code behind GCP's
 * HTTP 429 rateLimitExceeded. Quota errors that need an infrastructure
 * action (HTTP 403 quotaExceeded → PERMISSION_DENIED) deliberately keep the
 * unthrottled rejection so they surface instead of cooling down silently.
 */
const GCP_THROTTLE_GRPC_STATUS = 8
