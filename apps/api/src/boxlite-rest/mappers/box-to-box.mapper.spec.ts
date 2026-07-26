/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { boxToBoxResponse, createBoxToCreateBox } from './box-to-box.mapper'

describe('BoxLite Apps create allowlist mapper', () => {
  it('maps every implemented create field into the control-plane DTO', () => {
    const mapped = createBoxToCreateBox(
      {
        name: 'worker',
        image: 'base',
        cpus: 2,
        memory_mib: 1536,
        disk_size_gb: 8,
        env: { MODE: 'worker' },
        user: 'boxlite',
        network: {
          mode: 'enabled',
          allow_net: [' api.openai.com ', '10.0.0.0/8'],
        },
        auto_pause: 900,
        auto_delete: 3600,
        auto_resume: false,
      },
      'region-1',
    )

    expect(mapped).toEqual({
      name: 'worker',
      image: 'base',
      cpu: 2,
      memory: 2,
      disk: 8,
      env: { MODE: 'worker' },
      user: 'boxlite',
      target: 'region-1',
      networkBlockAll: false,
      networkAllowList: 'api.openai.com,10.0.0.0/8',
      autoPause: 900,
      autoDelete: 3600,
      autoResume: false,
    })
  })

  it('does not map the unpublished detach compatibility field', () => {
    const mapped = createBoxToCreateBox({ image: 'base', detach: true })

    expect(mapped).not.toHaveProperty('detach')
  })
})

describe('BoxLite lifecycle policy mapper', () => {
  it('maps second-based create fields into the control-plane DTO', () => {
    const mapped = createBoxToCreateBox({
      auto_pause: 1800,
      auto_delete: 604800,
      auto_resume: false,
    })

    expect(mapped.autoPause).toBe(1800)
    expect(mapped.autoDelete).toBe(604800)
    expect(mapped.autoResume).toBe(false)
  })

  it('returns the effective second-based policy', () => {
    const response = boxToBoxResponse({
      id: 'box-1',
      name: 'demo',
      state: BoxState.STARTED,
      labels: {},
      autoPause: 1800,
      autoDelete: 604800,
      autoResume: false,
    } as any)

    expect(response.auto_pause).toBe(1800)
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

  it('does not expose a runner-host PID in the Apps response', () => {
    const response = boxToBoxResponse({
      id: 'box-1',
      name: 'demo',
      state: BoxState.STARTED,
      labels: {},
      pid: 4321,
    } as any)

    expect(response).not.toHaveProperty('pid')
  })
})
