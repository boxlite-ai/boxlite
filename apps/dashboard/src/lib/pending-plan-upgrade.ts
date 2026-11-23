/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

const key = 'boxlite.billing.pendingUpgrade'
const checkoutWindowMs = 30 * 60 * 1000

export type PendingPlanUpgrade = {
  userId: string
  organizationId: string
  planId: string
  expiresAt: number
}

export function rememberPlanUpgrade(selection: Omit<PendingPlanUpgrade, 'expiresAt'>) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...selection, expiresAt: Date.now() + checkoutWindowMs }))
    return true
  } catch {
    return false
  }
}

// Only the page holding this confirmation can claim it before submitting.
export function clearPendingPlanUpgrade(selection?: PendingPlanUpgrade): boolean {
  try {
    if (selection && sessionStorage.getItem(key) !== JSON.stringify(selection)) return false
    sessionStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export function readPendingPlanUpgrade(): PendingPlanUpgrade | null {
  try {
    const stored = sessionStorage.getItem(key)
    if (!stored) return null
    const value = JSON.parse(stored)
    if (
      typeof value?.userId === 'string' &&
      typeof value.organizationId === 'string' &&
      typeof value.planId === 'string' &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt > Date.now()
    ) {
      return value
    }
  } catch {
    return null
  }
  return null
}
