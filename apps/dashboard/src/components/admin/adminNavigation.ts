/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export type AdminView = 'overview' | 'people' | 'fleet'

export const ADMIN_VIEWS: { id: AdminView; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'people', label: 'People & Boxes' },
  { id: 'fleet', label: 'Fleet' },
]

export function adminViewFromParam(value: string | null): AdminView | null {
  return ADMIN_VIEWS.some((view) => view.id === value) ? (value as AdminView) : null
}
