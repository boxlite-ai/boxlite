/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BOX_ID_LENGTH, BOX_ID_REGEX } from '../utils/box-id.util'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { Box } from './box.entity'

describe('Box entity public identity', () => {
  it('mints a single 12-character public id as the primary identity', () => {
    const box = new Box('us', 'data-loader')

    expect(box.id).toHaveLength(BOX_ID_LENGTH)
    expect(box.id).toMatch(BOX_ID_REGEX)
    expect((box as any).boxId).toBeUndefined()
    expect(box.name).toBe('data-loader')
  })
})

describe('Box entity destroy invariant', () => {
  it('keeps an errored box pending while a destroy intent is being reconciled', () => {
    const box = new Box('us', 'errored-box')
    box.state = BoxState.ERROR
    box.desiredState = BoxDesiredState.DESTROYED
    box.pending = true

    box.enforceInvariants()

    expect(box.pending).toBe(true)
  })
})

describe('Box entity snapshot operation states', () => {
  function boxIn(state: BoxState, desiredState: BoxDesiredState, pending: boolean): Box {
    const box = new Box('us', 'snapshot-box')
    box.state = state
    box.desiredState = desiredState
    box.pending = pending
    return box
  }

  // A box mid-snapshot differs from its desired state on purpose. If that read
  // as pending, every delete request (which requires !pending) would bounce.
  it.each([BoxState.EXPORTING, BoxState.IMPORTING])('keeps a %s box idle and valid', (state) => {
    const box = boxIn(state, BoxDesiredState.STOPPED, true)

    box.assertValid()
    box.enforceInvariants()

    expect(box.pending).toBe(false)
  })

  it.each([BoxState.EXPORTING, BoxState.IMPORTING])('admits a delete of a %s box', (state) => {
    const box = boxIn(state, BoxDesiredState.STOPPED, false)
    Object.assign(box, Box.getSoftDeleteUpdate(box))

    expect(() => box.assertValid()).not.toThrow()
    box.enforceInvariants()
    expect(box.pending).toBe(true)
  })

  it.each([BoxState.EXPORTING, BoxState.IMPORTING])('refuses to start a %s box', (state) => {
    const box = boxIn(state, BoxDesiredState.STARTED, true)

    expect(() => box.assertValid()).toThrow(/not in a valid state to be started/)
  })
})

describe('Box entity secret redaction', () => {
  it('omits the secrets field from JSON.stringify output', () => {
    const box = new Box('us', 'secret-box')
    box.secrets = [{ name: 'openai', value: 'sk-super-secret', hosts: ['api.openai.com'] }]

    const serialized = JSON.stringify(box)

    expect(serialized).not.toContain('sk-super-secret')
    expect(JSON.parse(serialized)).not.toHaveProperty('secrets')
  })

  it('keeps the secrets field absent when empty', () => {
    const box = new Box('us', 'no-secrets')

    // Check the field directly: a substring scan would false-positive on a
    // name like "no-secrets".
    expect(JSON.parse(JSON.stringify(box))).not.toHaveProperty('secrets')
  })
})
