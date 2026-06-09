/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import { ADMIN_VIEWS, adminViewFromParam } from './adminNavigation'

describe('admin navigation scope', () => {
  it('keeps platform telemetry inside overview instead of a top-level admin view', () => {
    expect(ADMIN_VIEWS.map((view) => view.label)).toEqual(['Overview', 'People & Boxes', 'Fleet'])
  })

  it('parses admin view query params safely', () => {
    expect(adminViewFromParam('platformTelemetry')).toBeNull()
    expect(adminViewFromParam('unknown')).toBeNull()
    expect(adminViewFromParam(null)).toBeNull()
  })
})
