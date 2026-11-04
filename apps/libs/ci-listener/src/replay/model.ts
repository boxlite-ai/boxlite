/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubDelivery, deliveryCursor, deliveryId } from '../deliveries'
import { object, positive } from '../execution/model'
import { StateCorrupt, StateRecord } from '../state/database'
export const retention = 3 * 24 * 3600000
export const interval = 300000
export const minute = 60000
export const progressKey = 'replay/progress'
export const itemPrefix = 'replay/item/'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
export interface ReplayDelivery {
  id: string
  guid: string
  installation: number
  event: string
  action: string
  time: number
}
export interface ReplayItem {
  version: 1
  delivery: ReplayDelivery
  done: boolean
  expiresAt: number
  nextAt: number
  attempts: number
  intent: string | null
}
export interface ReplayProgress {
  version: 1
  watermark: number
  scanAt: number
  scan: { since: number; started: number; cursor: string | null; seen: string[]; lastTime: number | null } | null
  retryAt: number
  retryAfter: string
  turn: 'page' | 'retry'
  notBefore: number
  failures: number
  gaps: number
}
function supported(event: string, action: string): boolean {
  return event === 'workflow_job'
    ? action === 'queued'
    : event === 'installation'
      ? ['created', 'deleted', 'new_permissions_accepted', 'suspend', 'unsuspend'].includes(action)
      : event === 'installation_repositories' && ['added', 'removed'].includes(action)
}
export function candidate(value: GitHubDelivery): ReplayDelivery | undefined {
  if (
    !value.installationId ||
    !value.action ||
    !supported(value.event, value.action) ||
    (value.event === 'workflow_job' && !value.repositoryId)
  )
    return
  return {
    id: value.id,
    guid: value.guid,
    installation: value.installationId,
    event: value.event,
    action: value.action,
    time: value.deliveredAt,
  }
}
export function initial(now: number): ReplayProgress {
  return {
    version: 1,
    watermark: Math.max(0, now - retention),
    scanAt: 0,
    scan: null,
    retryAt: 0,
    retryAfter: '',
    turn: 'page',
    notBefore: 0,
    failures: 0,
    gaps: 0,
  }
}
export function item(row: StateRecord): ReplayItem {
  const value = row.payload,
    d = object(value) ? value.delivery : undefined
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(d) ||
    typeof d.id !== 'string' ||
    typeof d.guid !== 'string' ||
    !uuid.test(d.guid) ||
    row.key !== itemPrefix + d.guid ||
    !positive(d.installation) ||
    typeof d.event !== 'string' ||
    typeof d.action !== 'string' ||
    !supported(d.event, d.action) ||
    !time(d.time) ||
    typeof value.done !== 'boolean' ||
    !time(value.expiresAt) ||
    value.expiresAt < d.time ||
    !time(value.nextAt) ||
    !time(value.attempts) ||
    value.attempts > 32 ||
    (value.attempts === 0 ? value.intent !== null : typeof value.intent !== 'string' || !uuid.test(value.intent))
  )
    throw new StateCorrupt()
  try {
    deliveryId(d.id)
  } catch {
    throw new StateCorrupt()
  }
  return {
    version: 1,
    delivery: { id: d.id, guid: d.guid, installation: d.installation, event: d.event, action: d.action, time: d.time },
    done: value.done,
    expiresAt: value.expiresAt,
    nextAt: value.nextAt,
    attempts: value.attempts,
    intent: value.intent as string | null,
  }
}
export function progress(row: StateRecord): ReplayProgress {
  const v = row.payload
  if (
    !object(v) ||
    row.key !== progressKey ||
    v.version !== 1 ||
    ![v.watermark, v.scanAt, v.retryAt, v.notBefore, v.failures, v.gaps].every(time) ||
    (v.failures as number) > 32 ||
    typeof v.retryAfter !== 'string' ||
    (v.retryAfter !== '' &&
      (!v.retryAfter.startsWith(itemPrefix) || !uuid.test(v.retryAfter.slice(itemPrefix.length)))) ||
    !['page', 'retry'].includes(v.turn as string)
  )
    throw new StateCorrupt()
  let scan: ReplayProgress['scan'] = null
  if (v.scan !== null) {
    const s = v.scan
    if (
      !object(s) ||
      !time(s.since) ||
      !time(s.started) ||
      s.since > s.started ||
      !(s.lastTime === null || time(s.lastTime)) ||
      !Array.isArray(s.seen) ||
      s.seen.length > 10000 ||
      !s.seen.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) ||
      new Set(s.seen).size !== s.seen.length ||
      !(s.cursor === null || typeof s.cursor === 'string')
    )
      throw new StateCorrupt()
    if (s.cursor !== null)
      try {
        deliveryCursor(s.cursor)
      } catch {
        throw new StateCorrupt()
      }
    scan = {
      since: s.since,
      started: s.started,
      lastTime: s.lastTime as number | null,
      cursor: s.cursor as string | null,
      seen: [...s.seen] as string[],
    }
  }
  return {
    version: 1,
    watermark: v.watermark as number,
    scanAt: v.scanAt as number,
    retryAt: v.retryAt as number,
    retryAfter: v.retryAfter,
    turn: v.turn as ReplayProgress['turn'],
    notBefore: v.notBefore as number,
    failures: v.failures as number,
    gaps: v.gaps as number,
    scan,
  }
}
export function merge(previous: ReplayItem | undefined, delivery: ReplayDelivery, success: boolean): ReplayItem {
  if (
    previous &&
    (previous.delivery.installation !== delivery.installation ||
      previous.delivery.event !== delivery.event ||
      previous.delivery.action !== delivery.action ||
      previous.delivery.guid !== delivery.guid)
  )
    throw new StateCorrupt()
  const latest =
    !previous ||
    delivery.time > previous.delivery.time ||
    (delivery.time === previous.delivery.time && BigInt(delivery.id) > BigInt(previous.delivery.id))
  return {
    version: 1,
    delivery: latest ? delivery : previous!.delivery,
    done: success || (previous?.done ?? false),
    expiresAt: Math.max(previous?.expiresAt ?? 0, delivery.time + retention),
    nextAt: previous?.nextAt ?? 0,
    attempts: previous?.attempts ?? 0,
    intent: previous?.intent ?? null,
  }
}
