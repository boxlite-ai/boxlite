/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { expect, it } from 'vitest'
import { BoxState, VolumeState } from '@boxlite-ai/api-client'
import { getBoxIconState, getVolumeIconState } from './resource-icon-state'

it.each([
  [BoxState.STARTED, 'success', false],
  [BoxState.STOPPED, 'neutral', false],
  [BoxState.ERROR, 'error', false],
  [BoxState.CREATING, 'warning', true],
  [BoxState.STARTING, 'warning', true],
  [BoxState.RESTORING, 'warning', true],
  [BoxState.STOPPING, 'warning', true],
  [BoxState.RESIZING, 'warning', true],
  [BoxState.DESTROYING, 'warning', true],
  [BoxState.ARCHIVING, 'warning', true],
  [BoxState.ARCHIVED, 'neutral', false],
  [BoxState.DESTROYED, 'neutral', false],
  [BoxState.UNKNOWN, 'neutral', false],
  ['future_state' as BoxState, 'neutral', false],
] as const)('gives the %s Box icon a lifecycle accent without animating stable states', (state, tone, active) => {
  expect(getBoxIconState({ state })).toEqual({ tone, active })
})

it.each([
  [VolumeState.READY, 'success', false],
  [VolumeState.PENDING_CREATE, 'warning', false],
  [VolumeState.CREATING, 'warning', true],
  [VolumeState.PENDING_DELETE, 'warning', false],
  [VolumeState.DELETING, 'warning', true],
  [VolumeState.ERROR, 'error', false],
  [VolumeState.DELETED, 'neutral', false],
  ['future_state', 'neutral', false],
] as const)('distinguishes active work from waiting in the %s Volume icon', (state, tone, active) => {
  expect(getVolumeIconState(state)).toEqual({ tone, active })
})
