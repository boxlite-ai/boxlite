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

describe('Box entity secret redaction', () => {
  it('omits secret values from JSON.stringify output', () => {
    const box = new Box('us', 'secret-box')
    box.secrets = [{ name: 'openai', value: 'sk-super-secret', hosts: ['api.openai.com'] }]

    const serialized = JSON.stringify(box)

    expect(serialized).not.toContain('sk-super-secret')
    expect(serialized).toContain('[1 secrets]')
  })

  it('keeps the secrets field absent when empty', () => {
    const box = new Box('us', 'no-secrets')

    expect(JSON.stringify(box)).not.toContain('secrets')
  })
})
