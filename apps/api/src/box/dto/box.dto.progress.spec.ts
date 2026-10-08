/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IMAGE_PREPARATION_RETRY_AFTER_MS } from '../constants/box-progress.constant'
import { Box } from '../entities/box.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxProgressPhase } from '../enums/box-progress-phase.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxDto } from './box.dto'

const PROXY = 'https://proxy.test/toolbox'

function box(state: BoxState, desiredState = BoxDesiredState.STARTED): Box {
  const created = new Box('us', 'data-loader')
  created.state = state
  created.desiredState = desiredState
  return created
}

describe('BoxDto progress', () => {
  it('reports the image being prepared while the box reads as creating', () => {
    const dto = BoxDto.fromBox(box(BoxState.CREATING), PROXY, { preparingImage: true })

    expect(dto.state).toBe(BoxState.CREATING)
    expect(dto.progress).toEqual({
      phase: BoxProgressPhase.PREPARING_IMAGE,
      retryAfterMs: IMAGE_PREPARATION_RETRY_AFTER_MS,
    })
  })

  /**
   * A box the runner has not reported on yet is stored as UNKNOWN and reported
   * as CREATING. Progress follows what the response says the box is doing, not
   * what the column holds, or the two would disagree inside one payload.
   */
  it('reports it for a box still stored as unknown', () => {
    const dto = BoxDto.fromBox(box(BoxState.UNKNOWN), PROXY, { preparingImage: true })

    expect(dto.state).toBe(BoxState.CREATING)
    expect(dto.progress?.phase).toBe(BoxProgressPhase.PREPARING_IMAGE)
  })

  it('omits it once the box has started', () => {
    const dto = BoxDto.fromBox(box(BoxState.STARTED), PROXY, { preparingImage: true })

    expect(dto.state).toBe(BoxState.STARTED)
    expect(dto.progress).toBeUndefined()
  })

  it('omits it for an image that has already been pulled', () => {
    const dto = BoxDto.fromBox(box(BoxState.CREATING), PROXY, { preparingImage: false })

    expect(dto.progress).toBeUndefined()
  })

  /**
   * Not a tautology: it fails if the field is ever written as a literal that
   * drifts from the constant the rest of the system publishes — which is the
   * only way this number can end up meaning two things.
   */
  it('carries the published retry hint rather than a number of its own', () => {
    const dto = BoxDto.fromBox(box(BoxState.CREATING), PROXY, { preparingImage: true })

    expect(dto.progress?.retryAfterMs).toBe(IMAGE_PREPARATION_RETRY_AFTER_MS)
  })

  it('leaves the field out entirely rather than sending an empty one', () => {
    const dto = BoxDto.fromBox(box(BoxState.STARTED), PROXY, { preparingImage: false })

    expect('progress' in dto).toBe(false)
  })
})
