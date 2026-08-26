/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { boxToBoxResponse, createBoxToCreateBox } from './box-to-box.mapper'

describe('BoxLite lifecycle policy mapper', () => {
  it.each([
    ['enabled', true],
    ['disabled', false],
  ])('maps inbound.mode=%s to control-plane public=%s', (mode, expected) => {
    const mapped = createBoxToCreateBox({
      network: {
        outbound: { mode: 'enabled' },
        inbound: { mode: mode as 'enabled' | 'disabled' },
      },
    })

    expect(mapped.public).toBe(expected)
  })

  it('maps second-based create fields into the control-plane DTO', () => {
    const mapped = createBoxToCreateBox({
      auto_stop: 1800,
      auto_delete: 604800,
      auto_resume: false,
    })

    expect(mapped.autoStop).toBe(1800)
    expect(mapped.autoDelete).toBe(604800)
    expect(mapped.autoResume).toBe(false)
  })

  it('maps REST volume specs to managed volume mounts', () => {
    const mapped = createBoxToCreateBox({
      volumes: [{ managed_volume: 'volume-123', guest_path: '/data', read_only: false }],
    })

    expect(mapped.volumes).toEqual([{ volumeId: 'volume-123', mountPath: '/data' }])
  })

  // A name is as valid as an id here; VolumeService.validateVolumes resolves
  // either, so the mapper must pass the value through untouched.
  it('passes a volume name through as-is', () => {
    const mapped = createBoxToCreateBox({
      volumes: [{ managed_volume: 'customer-data', guest_path: '/data', read_only: false }],
    })

    expect(mapped.volumes).toEqual([{ volumeId: 'customer-data', mountPath: '/data' }])
  })

  it('returns the effective second-based policy', () => {
    const response = boxToBoxResponse({
      id: 'box-1',
      name: 'demo',
      state: BoxState.STARTED,
      labels: {},
      autoStop: 1800,
      autoDelete: 604800,
      autoResume: false,
    } as any)

    expect(response.auto_stop).toBe(1800)
    expect(response.auto_delete).toBe(604800)
    expect(response.auto_resume).toBe(false)
  })

  it('defaults auto_resume to true when missing', () => {
    const response = boxToBoxResponse({
      id: 'box-1',
      name: 'demo',
      state: BoxState.STARTED,
      labels: {},
    } as any)

    expect(response.auto_resume).toBe(true)
  })
})
