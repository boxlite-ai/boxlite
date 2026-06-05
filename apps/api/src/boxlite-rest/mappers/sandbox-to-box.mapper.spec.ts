/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createBoxToCreateSandbox, resolveBoxTemplateId } from './sandbox-to-box.mapper'

describe('sandbox-to-box mapper', () => {
  it('maps SDK image tags to approved templates', () => {
    expect(resolveBoxTemplateId('ubuntu:24.04')).toBe('ubuntu:24.04')
    expect(resolveBoxTemplateId('debian:13-slim')).toBe('debian:13-slim')
    expect(resolveBoxTemplateId('alpine:3.23')).toBe('alpine:3.23')
  })

  it('uses the default Linux template when the SDK omits image', () => {
    expect(createBoxToCreateSandbox({ name: 'my-box' }).templateId).toBe('ubuntu:24.04')
  })

  it('maps SDK resource settings to template create overrides', () => {
    const dto = createBoxToCreateSandbox({
      cpus: 2,
      memory_mib: 1536,
      disk_size_gb: 8,
    })

    expect(dto.cpu).toBe(2)
    expect(dto.memory).toBe(2)
    expect(dto.disk).toBe(8)
  })

  it('leaves unsupported images unresolved so the controller can reject them', () => {
    expect(createBoxToCreateSandbox({ image: 'node:22' }).templateId).toBeUndefined()
  })
})
