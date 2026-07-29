/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { boxToBoxResponse, createBoxToCreateBox } from './box-to-box.mapper'

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

  it('maps foreground launch settings into the persisted control-plane DTO', () => {
    const mapped = createBoxToCreateBox({
      image: 'sandbaseai-hermes',
      entrypoint: ['/bin/sh'],
      cmd: ['-lc', 'echo foreground-ok; exit 7'],
      working_dir: '/workspace',
      tty: true,
      detach: false,
      auto_delete: 1,
    })

    expect(mapped.launchConfig).toEqual({
      entrypoint: ['/bin/sh'],
      cmd: ['-lc', 'echo foreground-ok; exit 7'],
      workingDir: '/workspace',
      tty: true,
      detach: false,
      foreground: true,
      autoDeleteAfterExit: true,
    })
  })

  it('does not persist an empty launch config for ordinary creates', () => {
    const mapped = createBoxToCreateBox({ image: 'alpine:3.23' })

    expect(mapped.launchConfig).toBeUndefined()
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
})
