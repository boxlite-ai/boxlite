/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, Optional } from '@nestjs/common'
import { RunnerDataDiskRef } from '../common/runner-data-disk-ref'

/** GCP rejected the resize with 400 — for this API's budget that means the per-disk resize rate limit. */
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

/** The surface the expansion controller needs; fakes implement exactly this in tests. */
export interface GcpDiskClientLike {
  resizeDisk(ref: RunnerDataDiskRef, sizeGb: number): Promise<{ operation: string }>
  getZoneOperation(ref: RunnerDataDiskRef, operation: string): Promise<GcpZoneOperation>
}

// Structural slices of the generated @google-cloud/compute clients, so tests
// can supply plain objects without dragging the generated types in.
interface DisksLike {
  update(request: {
    project: string
    zone: string
    disk: string
    diskResource: { sizeGb: string }
    paths: string[]
  }): Promise<{ name: string }[]>
}

interface ZoneOperationsLike {
  get(request: { project: string; zone: string; operation: string }): Promise<
    { name?: string; status?: string; error?: { errors?: { code?: string; message?: string }[] } }[]
  >
}

/**
 * Thin wrapper over the two GCP Compute calls the expansion controller makes:
 * growing a disk (`disks.update`) and polling the zone operation it returns.
 *
 * Two invariants live here and are pinned by tests:
 * - `paths` is exactly `['sizeGb']`. The v1 client also accepts `updateMask`,
 *   but it is silently ignored there — the request then goes out without
 *   `paths` as a full PATCH, which would reset provisionedIops/Throughput to
 *   defaults. Only `paths` reaches GCP as the field mask.
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

  async resizeDisk(ref: RunnerDataDiskRef, sizeGb: number): Promise<{ operation: string }> {
    let operation: { name: string } | undefined
    try {
      ;[operation] = await this.disksClient().update({
        project: ref.project,
        zone: ref.zone,
        disk: ref.diskName,
        diskResource: { sizeGb: String(sizeGb) },
        paths: ['sizeGb'],
      })
    } catch (e) {
      // Map here so callers only ever see this module's error classes: a
      // rate-limit answer and a broken transport must not be confused.
      throw toExpansionClientError(e)
    }
    return { operation: operation.name }
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

/** Maps a raw @google-cloud/compute failure to the expansion controller's error classes. */
export function toExpansionClientError(error: unknown): Error {
  const status = (error as { code?: number })?.code
  const message = error instanceof Error ? error.message : String(error)
  if (status === 400) {
    return new GcpDiskRateLimitedError(message)
  }
  return error instanceof Error ? error : new Error(message)
}
