/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// ─── admin-only API shapes (not in the generated api-client) ──────────────────

export interface AdminOverview {
  users: number
  activeBoxes: number
  boxes: { total: number; byState: Record<string, number> }
  runners: { online: number; total: number; draining: number }
  cluster: { cpuUtil: number; oversell: number }
}

export interface AdminUser {
  id: string
  email: string
  name: string
  role: string
}

export interface AdminBoxOwner {
  userId?: string
  name: string
  email: string
  orgName: string
  personal: boolean
}

export interface AdminBox {
  id: string
  boxId?: string
  organizationId: string
  state: string
  runnerId: string | null
  cpu: number
  memoryGiB: number
  createdAt: string
  owner: AdminBoxOwner
}

export interface AdminRunner {
  id: string
  state: string
  cpu: number
  memory: number
  currentAllocatedCpu: number
  currentAllocatedMemoryGiB: number
  currentStartedBoxes: number
  availabilityScore: number
  draining: boolean
  unschedulable: boolean
}

export interface AdminMachine {
  host: string
  region: string
  oversellCpu: number
  cpuWaterline: number
  memWaterline: number
  boxes: number
}

// ─── state → visual ───────────────────────────────────────────────────────────

export type StateVariant = 'success' | 'destructive' | 'warning' | 'secondary'

export function stateBadgeVariant(state: string): StateVariant {
  const lower = state?.toLowerCase() ?? ''
  if (lower === 'running' || lower === 'online' || lower === 'started' || lower === 'ready') {
    return 'success'
  }
  if (lower === 'error' || lower === 'failed' || lower === 'build_failed') {
    return 'destructive'
  }
  if (lower === 'draining' || lower === 'stopping') {
    return 'warning'
  }
  return 'secondary'
}

export function isErrorState(state: string): boolean {
  const lower = state?.toLowerCase() ?? ''
  return lower === 'error' || lower === 'failed' || lower === 'build_failed'
}

// Balanced status palette — shared with the box-breakdown bars (kept in sync with
// the dashboard's existing admin breakdown colors so old and new views match).
export const BOX_STATE_COLORS: Record<string, string> = {
  started: '#5aac7b',
  error: '#dd7d70',
  build_failed: '#d6a84f',
  stopped: '#838b97',
  other: '#444a54',
}

// ─── box breakdown ──────────────────────────────────────────────────────────

export interface BreakdownSegment {
  key: string
  label: string
  count: number
  color: string
}

const BREAKDOWN_ORDER: { key: string; label: string }[] = [
  { key: 'started', label: 'started' },
  { key: 'error', label: 'error' },
  { key: 'build_failed', label: 'build failed' },
  { key: 'stopped', label: 'stopped' },
]

export function getBoxBreakdown(boxes: AdminBox[]): BreakdownSegment[] {
  const counts = boxes.reduce<Record<string, number>>((acc, b) => {
    acc[b.state] = (acc[b.state] ?? 0) + 1
    return acc
  }, {})

  const known = BREAKDOWN_ORDER.map(({ key, label }) => ({
    key,
    label,
    count: counts[key] ?? 0,
    color: BOX_STATE_COLORS[key] ?? BOX_STATE_COLORS.other,
  }))
  const knownTotal = known.reduce((sum, s) => sum + s.count, 0)
  const other = Math.max(boxes.length - knownTotal, 0)

  return [...known, { key: 'other', label: 'other', count: other, color: BOX_STATE_COLORS.other }].filter(
    (s) => s.count > 0,
  )
}

// ─── owner grouping ───────────────────────────────────────────────────────────

export interface OwnerGroup {
  organizationId: string
  owner: AdminBoxOwner
  boxes: AdminBox[]
  breakdown: BreakdownSegment[]
}

export function groupBoxesByOwner(boxes: AdminBox[]): OwnerGroup[] {
  const groups = new Map<string, { owner: AdminBoxOwner; boxes: AdminBox[] }>()

  for (const b of boxes) {
    const existing = groups.get(b.organizationId)
    if (existing) {
      existing.boxes.push(b)
    } else {
      groups.set(b.organizationId, { owner: b.owner, boxes: [b] })
    }
  }

  return Array.from(groups.entries())
    .map(([organizationId, group]) => ({
      organizationId,
      owner: group.owner,
      boxes: group.boxes,
      breakdown: getBoxBreakdown(group.boxes),
    }))
    .sort((a, b) => a.owner.name.localeCompare(b.owner.name))
}

export function getBoxRollupText(boxes: AdminBox[]): string {
  const counts = boxes.reduce<Record<string, number>>((acc, b) => {
    acc[b.state] = (acc[b.state] ?? 0) + 1
    return acc
  }, {})
  const parts = [
    { label: 'started', count: counts.started ?? 0 },
    { label: 'error', count: counts.error ?? 0 },
    { label: 'build failed', count: counts.build_failed ?? 0 },
  ].filter((p) => p.count > 0)

  return parts.length > 0 ? parts.map((p) => `${p.count} ${p.label}`).join(' · ') : 'idle'
}

// ─── runners ──────────────────────────────────────────────────────────────────

export function isOnlineRunner(runner: AdminRunner): boolean {
  return runner.state?.toLowerCase() === 'ready'
}

export function runnerCpuPercent(runner: AdminRunner): number {
  return runner.cpu > 0 ? runner.currentAllocatedCpu / runner.cpu : 0
}

// ─── search & attention selectors ─────────────────────────────────────────────

export function filterOwnerGroups(groups: OwnerGroup[], query: string): OwnerGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return groups

  const result: OwnerGroup[] = []
  for (const group of groups) {
    const ownerMatches = group.owner.name.toLowerCase().includes(q) || group.owner.email.toLowerCase().includes(q)
    if (ownerMatches) {
      result.push(group)
      continue
    }
    const matchingBoxes = group.boxes.filter(
      (b) => b.id.toLowerCase().includes(q) || b.boxId?.toLowerCase().includes(q),
    )
    if (matchingBoxes.length > 0) {
      result.push({ ...group, boxes: matchingBoxes, breakdown: getBoxBreakdown(matchingBoxes) })
    }
  }
  return result
}

export interface ErroringOwner {
  group: OwnerGroup
  errorBoxes: AdminBox[]
}

export function selectErroringOwners(groups: OwnerGroup[]): ErroringOwner[] {
  return groups
    .map((group) => ({ group, errorBoxes: group.boxes.filter((b) => isErrorState(b.state)) }))
    .filter((x) => x.errorBoxes.length > 0)
    .sort((a, b) => b.errorBoxes.length - a.errorBoxes.length)
}

export function findBoxById(groups: OwnerGroup[], boxId: string): { box: AdminBox; group: OwnerGroup } | undefined {
  const targetBoxId = boxId.trim().toLowerCase()
  for (const group of groups) {
    const box = group.boxes.find((b) => b.id.toLowerCase() === targetBoxId || b.boxId?.toLowerCase() === targetBoxId)
    if (box) return { box, group }
  }
  return undefined
}
