/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

/** A decorative ratio beside exact quota text; unknown/unlimited/paused limits have no meter. */
export function QuotaTicks({ used, limit }: { used: number; limit: number | null | undefined }) {
  if (!Number.isFinite(used) || used < 0 || limit == null || !Number.isFinite(limit) || limit <= 0) return null
  const ticks = Math.min(1, used / limit) * 10
  return (
    <span className="quota-ticks" aria-hidden="true">
      {Array.from({ length: 10 }, (_, index) => (
        <span key={index} className="quota-tick">
          <span style={{ width: `${Math.max(0, Math.min(1, ticks - index)) * 100}%` }} />
        </span>
      ))}
    </span>
  )
}
