/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TraceSpan } from '@boxlite-ai/api-client'

export interface TraceWaterfallRow extends TraceSpan {
  depth: number
  durationMs: number
  offsetPercent: number
  widthPercent: number
}

interface SpanNode extends TraceSpan {
  children: SpanNode[]
}

interface TraceLike {
  traceId: string
}

function sortByStartTime<T extends { timestamp: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

export function resolveSelectedTraceId<T extends TraceLike>(traces: T[] | undefined, selectedTraceId: string | null) {
  if (!traces?.length) return null
  if (selectedTraceId && traces.some((trace) => trace.traceId === selectedTraceId)) return selectedTraceId
  return traces[0].traceId
}

export function buildTraceWaterfallRows(spans: TraceSpan[] | undefined): TraceWaterfallRow[] {
  if (!spans?.length) return []

  const spanMap = new Map<string, SpanNode>()
  const roots: SpanNode[] = []

  for (const span of spans) {
    spanMap.set(span.spanId, { ...span, children: [] })
  }

  for (const span of spans) {
    const node = spanMap.get(span.spanId)
    if (!node) continue

    const parent = span.parentSpanId ? spanMap.get(span.parentSpanId) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const startTimes = spans.map((span) => new Date(span.timestamp).getTime())
  const endTimes = spans.map((span, index) => startTimes[index] + span.durationNs / 1_000_000)
  const traceStart = Math.min(...startTimes)
  const traceDurationMs = Math.max(...endTimes) - traceStart

  const rows: TraceWaterfallRow[] = []

  const appendRows = (nodes: SpanNode[], depth: number) => {
    for (const node of sortByStartTime(nodes)) {
      const spanStart = new Date(node.timestamp).getTime()
      const durationMs = node.durationNs / 1_000_000
      const offsetPercent = traceDurationMs > 0 ? ((spanStart - traceStart) / traceDurationMs) * 100 : 0
      const widthPercent = traceDurationMs > 0 ? (durationMs / traceDurationMs) * 100 : 100

      rows.push({
        ...node,
        depth,
        durationMs,
        offsetPercent: Math.round(offsetPercent * 100) / 100,
        widthPercent: Math.round(widthPercent * 100) / 100,
      })
      appendRows(node.children, depth + 1)
    }
  }

  appendRows(roots, 0)
  return rows
}
