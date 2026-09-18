/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxDto } from './box.dto'

describe('BoxDto public identity', () => {
  it('exposes a single public id without a legacy boxId alias', () => {
    const box = new Box('us', 'data-loader')
    box.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    box.osUser = 'boxlite'

    const dto = BoxDto.fromBox(box, 'https://proxy.boxlite.dev/toolbox')

    expect(dto.id).toBe(box.id)
    expect((dto as any).boxId).toBeUndefined()
  })
})

describe('BoxDto main command exit code', () => {
  function boxWith(exitCode: number | null | undefined): Box {
    const box = new Box('us', 'loader')
    box.id = 'box-1'
    box.exitCode = exitCode
    return box
  }

  // 0 is what tells a box that finished its work from one that crashed, so it
  // has to survive the conversion as a value.
  it.each([
    ['a failing main command', 137, 137],
    ['a main command that succeeded', 0, 0],
  ])('reports the exit code of %s', (_case, stored, expected) => {
    expect(BoxDto.fromBox(boxWith(stored), 'https://proxy.invalid').exitCode).toBe(expected)
  })

  // Absent, never null: the generated clients type this as an optional number,
  // and every other layer says absence is what "not recorded" looks like.
  it.each([
    ['a box that never stopped that way', null],
    ['a box from before the column existed', undefined],
  ])('omits the exit code for %s', (_case, stored) => {
    const dto = BoxDto.fromBox(boxWith(stored), 'https://proxy.invalid')

    expect(dto.exitCode).toBeUndefined()
    expect(JSON.parse(JSON.stringify(dto))).not.toHaveProperty('exitCode')
  })
})
