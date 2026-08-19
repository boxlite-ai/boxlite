/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * A plan in the public catalog. `null` on `priceMonthlyCents` means
 * negotiated outside the system (contact sales), not a real gap in the
 * catalog. `null` on `includedQuotaCents`/`concurrencyLimit` means
 * unlimited, not zero.
 *
 * Custom (Enterprise-negotiated) deals never appear here — only the
 * standard, named plans a caller could self-serve subscribe to. An
 * organization on a custom deal still reads its own plan through
 * `GET organization/:id/plan`; it just has no catalog row.
 */
export type Plan = {
  id: string
  name: string
  priceMonthlyCents: number | null
  includedQuotaCents: number | null
  concurrencyLimit: number | null
  selfServe: boolean
}
