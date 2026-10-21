/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getRelativeTimeString } from '@/lib/utils'
import type { AppStatus, AppVisibility, ReleaseStatus } from './types'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function relTime(timestamp: string | undefined | null): string {
  return getRelativeTimeString(timestamp).relativeTimeString
}

// One status language for every App screen: a colour means the same thing
// everywhere. Green healthy, amber needs attention or is in progress, red has
// failed, grey is expected inactivity (not deployed yet, asleep).
// The console's status tokens, so a running app and a running box are the same green.
export const STATUS = {
  running: 'hsl(var(--success))',
  idle: 'hsl(var(--warning))',
  stopped: 'hsl(var(--muted-foreground))',
  error: 'hsl(var(--destructive))',
  dim: 'hsl(var(--muted-foreground))',
} as const

/** Runtime state of an environment, worded for people: what is running now. */
export function appStatusOf(status: AppStatus): { label: string; color: string } {
  switch (status) {
    case 'live':
      return { label: 'Running', color: STATUS.running }
    case 'building':
      return { label: 'Deploying', color: STATUS.idle }
    case 'degraded':
      return { label: 'Degraded', color: STATUS.idle }
    case 'sleeping':
      return { label: 'Sleeping', color: STATUS.stopped }
    case 'failed':
      return { label: 'Failed', color: STATUS.error }
    case 'draft':
    default:
      return { label: 'Not deployed', color: STATUS.dim }
  }
}

/** A deployment's status as the control plane reports it. */
export function releaseStatusOf(status: ReleaseStatus): { label: string; color: string } {
  switch (status) {
    case 'live':
      return { label: 'Live', color: STATUS.running }
    case 'failed':
      return { label: 'Failed', color: STATUS.error }
    case 'superseded':
      return { label: 'Superseded', color: STATUS.dim }
    case 'rolled_back':
      return { label: 'Rolled back', color: STATUS.dim }
    case 'cancelled':
      return { label: 'Cancelled', color: STATUS.dim }
    default:
      return { label: capitalize(status), color: STATUS.idle }
  }
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export const VISIBILITY_LABEL: Record<AppVisibility, string> = {
  private: 'private',
  org: 'org members',
  public: 'public',
}

export const VISIBILITY_GLYPH: Record<AppVisibility, string> = {
  private: '○',
  org: '◐',
  public: '◎',
}

export const VISIBILITY_ORDER: AppVisibility[] = ['private', 'org', 'public']

/** Control-plane rule for App and environment names (contracts §0 plus the proxy's limits). */
export function nameProblem(name: string, reserved: string[] = []): string | null {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name))
    return 'Use 2–31 lowercase letters, digits and dashes, starting with a letter.'
  if (name.includes('--')) return 'Two dashes in a row separate app and environment in URLs.'
  if (name.endsWith('-')) return 'It cannot end with a dash.'
  if (reserved.includes(name)) return `${name} is reserved by the control plane.`
  return null
}

/** 12.3 s, 1:05, 1:02:03 — durations of steps and deployments. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** A timestamp as UTC and in the reader's time zone, e.g. "14:05 UTC · 22:05 local". */
export function utcAndLocal(iso: string): string {
  const d = new Date(iso)
  const utc = d.toISOString().slice(11, 16)
  const local = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const day =
    d.toDateString() === new Date().toDateString()
      ? ''
      : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} `
  return `${day}${utc} UTC · ${local} local`
}
