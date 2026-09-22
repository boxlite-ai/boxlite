/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BoxService } from './box.service'

// resolveLifecyclePolicy reads nothing off `this`, so the prototype alone is
// enough — same shortcut as box.service.box-id.spec.ts.
function resolveLifecyclePolicy(input: { autoStop?: number; autoDelete?: number; autoResume?: boolean }) {
  const service = Object.create(BoxService.prototype) as BoxService
  return (service as any).resolveLifecyclePolicy(input)
}

// The preview proxy refreshes a running box's idle timer on a fixed 50s poll
// (apps/proxy/pkg/proxy/get_box_target.go), so an idle window shorter than one
// poll lapses between two renewals and the box is reaped with traffic flowing:
// measured on dev with auto_stop=30, the box was running at t=31s and stopping
// at t=37s while the preview URL was being polled. Numbers are spelled out
// rather than imported so reverting the production change leaves this suite
// compiling — and failing for the right reason.
describe('BoxService auto-stop floor', () => {
  it.each([1, 30, 59])('rejects an auto-stop of %ss, which renewal cannot keep alive', (autoStop) => {
    expect(() => resolveLifecyclePolicy({ autoStop })).toThrow('Auto-stop interval must be 0 (disabled) or at least 60')
  })

  it('accepts 0, which disables auto-stop rather than asking for a 0s window', () => {
    expect(resolveLifecyclePolicy({ autoStop: 0 })).toMatchObject({ autoStop: 0 })
  })

  it('accepts the floor itself', () => {
    expect(resolveLifecyclePolicy({ autoStop: 60, autoDelete: 120 })).toMatchObject({ autoStop: 60, autoDelete: 120 })
  })

  it('applies the default when auto-stop is omitted', () => {
    expect(resolveLifecyclePolicy({})).toMatchObject({ autoStop: 900 })
  })
})
