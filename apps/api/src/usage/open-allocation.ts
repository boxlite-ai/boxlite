/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { identityString, quantityString, timestampString } from './usage-event'

/**
 * A still-open usage period, in the shape `BoxUsagePeriod` has before its
 * `endAt` is known.
 *
 * Unlike `FinalizedUsagePeriod`, there is no `endAt` here at all: an open
 * period has no end yet, and giving the type an optional field would let a
 * closed period slip in by omission instead of by the caller's choice.
 */
export interface OpenAllocation {
  organizationId: string
  boxId: string
  region: string
  startAt: Date
  cpu: number
  gpu: number
  mem: number
  disk: number
}

/**
 * One open allocation, exactly as it crosses the wire in a snapshot push.
 *
 * No `eventKey`: unlike a finalized usage event, a snapshot row has no
 * standalone identity to deliver at-least-once — the whole push is a single
 * replace-all fact, identified by `asOf` on the envelope that carries these.
 */
export interface OpenAllocationDto {
  organizationId: string
  boxId: string
  region: string
  startAt: string
  cpu: string
  gpu: string
  mem: string
  disk: string
}

/**
 * Builds the exact bytes sent to Commerce for one open allocation.
 *
 * Reuses `usage-event.ts`'s field encoders so an open allocation and a
 * finalized one describe organizationId/boxId/region/quantities identically —
 * the two payloads differ only in which interval fields they carry.
 */
export function toOpenAllocationDto(allocation: OpenAllocation): OpenAllocationDto {
  return {
    organizationId: identityString(allocation.organizationId, 'organizationId'),
    boxId: identityString(allocation.boxId, 'boxId'),
    region: identityString(allocation.region, 'region'),
    startAt: timestampString(allocation.startAt, 'startAt'),
    cpu: quantityString(allocation.cpu, 'cpu'),
    gpu: quantityString(allocation.gpu, 'gpu'),
    mem: quantityString(allocation.mem, 'mem'),
    disk: quantityString(allocation.disk, 'disk'),
  }
}
