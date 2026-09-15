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

  it('maps REST secret specs to secret placeholder rules', () => {
    const mapped = createBoxToCreateBox({
      secrets: [
        { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
      ],
    })

    expect(mapped.secrets).toEqual([
      { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
    ])
  })

  it('passes a secret without hosts/placeholder through untouched', () => {
    const mapped = createBoxToCreateBox({
      secrets: [{ name: 'openai', value: 'sk-test' }],
    })

    expect(mapped.secrets).toEqual([{ name: 'openai', value: 'sk-test' }])
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

  it('reports the effective cloud policy needed for named-box reuse', () => {
    const response = boxToBoxResponse({
      id: 'box-1',
      name: 'demo',
      state: BoxState.STARTED,
      labels: {},
    } as any)

    expect(response.advanced).toEqual({
      capabilities: { add: [], drop: [] },
      privileged: false,
      nested_virtualization: false,
    })
  })
})

// These four validated, were audit-logged, and were then dropped on the floor
// here: the mapper simply never read them, so a caller got a 201 and a box that
// ignored the working directory, entrypoint, command and user they asked for.
describe('BoxLite container process options mapper', () => {
  it('carries the container process options into the control-plane DTO', () => {
    const mapped = createBoxToCreateBox({
      working_dir: '/app',
      entrypoint: ['python'],
      cmd: ['-c', 'print(1)'],
      user: '1000:1000',
    })

    expect(mapped.workingDir).toBe('/app')
    expect(mapped.entrypoint).toEqual(['python'])
    expect(mapped.cmd).toEqual(['-c', 'print(1)'])
    expect(mapped.runAsUser).toBe('1000:1000')
  })

  // `user` feeds two fields with different jobs. runAsUser is the real OCI
  // process.user override; osUser is the Daytona-era warm-pool label, and
  // box.service.ts still defaults it to 'boxlite' when absent.
  it('feeds user to both the process override and the warm-pool label', () => {
    const mapped = createBoxToCreateBox({ user: 'node' })

    expect(mapped.runAsUser).toBe('node')
    expect(mapped.user).toBe('node')
  })

  // The load-bearing case: an unset user must stay unset, so box.service.ts
  // does not hand every box a USER override its image may never define.
  it('leaves runAsUser undefined when the caller asks for no user', () => {
    const mapped = createBoxToCreateBox({ image: 'alpine:latest' })

    expect(mapped.runAsUser).toBeUndefined()
    expect(mapped.workingDir).toBeUndefined()
    expect(mapped.entrypoint).toBeUndefined()
    expect(mapped.cmd).toBeUndefined()
  })
})
