/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { PlanTrialEligibility } from '@/billing-api'

export function trialDuration(offer: PlanTrialEligibility | undefined): string | undefined {
  if (offer?.eligible !== true || !Number.isSafeInteger(offer.durationSeconds) || offer.durationSeconds <= 0) return
  const seconds = offer.durationSeconds
  const units = [
    [86400, 'Day', 'd'],
    [3600, 'Hour', 'h'],
    [60, 'Minute', 'm'],
    [1, 'Second', 's'],
  ] as const
  const parts: string[] = []
  let remaining = seconds
  for (const [size, name, suffix] of units) {
    const count = Math.floor(remaining / size)
    if (!count) continue
    if (count * size === seconds) return `${count} ${name}${count === 1 ? '' : 's'}`
    parts.push(`${count}${suffix}`)
    remaining %= size
  }
  return parts.join(' ')
}
