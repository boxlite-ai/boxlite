/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
// Navigation identity only; this is not a security token.
const DOCUMENT_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
const PREFIX = 'boxlite:plan-card-setup:'
const MAX_AGE_MS = 30 * 60 * 1000
const key = (subject: string, organizationId: string) => PREFIX + JSON.stringify([subject, organizationId])

/** Tab-local navigation intent only. Never authorizes a subscription or proves payment. */
export function savePlanSetup(subject: string, organizationId: string, planId: string): boolean {
  try {
    sessionStorage.setItem(
      key(subject, organizationId),
      JSON.stringify({ planId, at: Date.now(), documentId: DOCUMENT_ID }),
    )
    return true
  } catch {
    return false
  }
}

export function discardPlanSetup(subject: string, organizationId: string) {
  try {
    sessionStorage.removeItem(key(subject, organizationId))
  } catch {
    /* Storage can be unavailable. */
  }
}

export function consumePlanSetup(subject: string, organizationId: string, requireNewDocument = false): string | null {
  try {
    const stored = sessionStorage.getItem(key(subject, organizationId))
    if (!stored) return null
    const value = JSON.parse(stored)
    if (requireNewDocument && value?.documentId === DOCUMENT_ID) return null
    discardPlanSetup(subject, organizationId)
    if (
      typeof value.planId !== 'string' ||
      !value.planId ||
      value.planId.length > 200 ||
      typeof value.at !== 'number' ||
      !Number.isFinite(value.at) ||
      Date.now() < value.at ||
      Date.now() - value.at > MAX_AGE_MS
    )
      return null
    return value.planId
  } catch {
    return null
  }
}
