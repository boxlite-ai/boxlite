/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDto } from '../../box/dto/box.dto'
import { boxToBoxResponse, createBoxToCreateBox, resolveSystemTemplateId } from './box-to-box.mapper'

describe('box-to-box mapper', () => {
  it('maps REST box_id from the public box boxId instead of the internal UUID', () => {
    const response = boxToBoxResponse({
      id: 'fd955d93-e74a-48e7-9f2d-fcbe6dd9e920',
      boxId: 'aB3cD4eF5gH6',
      organizationId: '057963b2-60ca-4356-81fc-11503e15f249',
      name: 'data-loader',
      state: 'started',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z',
      target: 'us',
      user: 'boxlite',
      env: {},
      cpu: 1,
      gpu: 0,
      memory: 1,
      disk: 3,
      public: false,
      networkBlockAll: false,
      labels: {},
      toolboxProxyUrl: 'https://proxy.boxlite.dev/toolbox',
    } as BoxDto)

    expect(response.box_id).toBe('aB3cD4eF5gH6')
    expect(response.box_id).not.toBe('fd955d93-e74a-48e7-9f2d-fcbe6dd9e920')
  })

  it('maps SDK image names to approved agent-ready templates', () => {
    expect(resolveSystemTemplateId('boxlite/base')).toBe('boxlite/base')
    expect(resolveSystemTemplateId('boxlite/python')).toBe('boxlite/python')
    expect(resolveSystemTemplateId('boxlite/node')).toBe('boxlite/node')
  })

  it('maps legacy approved OS image tags to the base runtime compatibility alias', () => {
    expect(resolveSystemTemplateId('ubuntu:24.04')).toBe('boxlite/base')
    expect(resolveSystemTemplateId('debian:13-slim')).toBe('boxlite/base')
    expect(resolveSystemTemplateId('alpine:3.23')).toBe('boxlite/base')
  })

  it('uses the default agent-ready image when the SDK omits image', () => {
    expect(createBoxToCreateBox({ name: 'my-box' }).templateId).toBe('boxlite/base')
  })

  it('maps SDK resource settings to box create overrides', () => {
    const dto = createBoxToCreateBox({
      cpus: 2,
      memory_mib: 1536,
      disk_size_gb: 8,
    })

    expect(dto.cpu).toBe(2)
    expect(dto.memory).toBe(2)
    expect(dto.disk).toBe(8)
  })

  it('leaves unsupported images unresolved so the controller can reject them', () => {
    expect(createBoxToCreateBox({ image: 'node:22' }).templateId).toBeUndefined()
  })
})
