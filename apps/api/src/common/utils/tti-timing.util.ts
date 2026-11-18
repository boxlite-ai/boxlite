/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export type TimingStatus = 'ok' | 'error' | 'skipped'

export interface TimingIds {
  box_id?: string | null
  job_id?: string | null
  exec_id?: string | null
}

/** The runner timing event contract; absent correlation IDs are omitted. */
export interface TimingEvent {
  op: string
  stage: string
  status: TimingStatus
  dur_ms: number
  box_id?: string
  job_id?: string
  exec_id?: string
  ts: string
}

const EVENTS_PER_BOX = 256
const MAX_BOXES = 1024

interface BoxHistory {
  events: TimingEvent[]
  next: number
}

// Map iteration is least to most recently written. Reads leave this order alone.
const boxes = new Map<string, BoxHistory>()

/** Captures a monotonic start, or skips timing if the clock fails. */
export function startTiming(): bigint | undefined {
  try {
    return process.hrtime.bigint()
  } catch {
    return undefined
  }
}

/** Records a phase without I/O or exposing probe failures to the caller. */
export function emitTiming(
  op: string,
  stage: string,
  status: TimingStatus,
  startedAt: ReturnType<typeof startTiming>,
  ids: TimingIds,
  endedAt?: bigint,
): void {
  try {
    if (startedAt === undefined) return
    const { box_id, job_id, exec_id } = ids
    if (!box_id) return

    const event: TimingEvent = {
      op,
      stage,
      status,
      dur_ms: Number(((endedAt ?? process.hrtime.bigint()) - startedAt) / 1_000_000n),
      box_id,
      ...(job_id ? { job_id } : {}),
      ...(exec_id ? { exec_id } : {}),
      ts: new Date().toISOString(),
    }

    const box = boxes.get(box_id) ?? { events: [], next: 0 }
    box.events[box.next] = event
    box.next = (box.next + 1) % EVENTS_PER_BOX
    boxes.delete(box_id)
    boxes.set(box_id, box)
    if (boxes.size > MAX_BOXES) {
      const oldest = boxes.keys().next()
      if (!oldest.done) boxes.delete(oldest.value)
    }
  } catch {
    // Dropping a measurement is preferable to changing the operation's outcome.
  }
}

/** Returns a detached copy in oldest-to-newest write order. */
export function snapshotTiming(boxId: string): TimingEvent[] {
  try {
    const box = boxes.get(boxId)
    if (!box) return []

    const oldest = (box.next + EVENTS_PER_BOX - box.events.length) % EVENTS_PER_BOX
    return box.events.map((_, index) => ({ ...box.events[(oldest + index) % EVENTS_PER_BOX] }))
  } catch {
    return []
  }
}

/** Clears process-local timing history between tests. */
export function resetTimingForTest(): void {
  boxes.clear()
}
