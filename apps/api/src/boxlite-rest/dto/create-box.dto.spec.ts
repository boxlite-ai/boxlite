/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { CreateBoxDto } from './create-box.dto'

// A box with 0 vCPUs can never boot (libkrun set_vm_config(0, ...) -> EINVAL),
// so the create endpoint must reject undersized resources at the request
// boundary. These assert the @Min constraints stay wired on CreateBoxDto —
// drop a decorator and the matching case goes red. (The global ValidationPipe
// in main.ts turns these constraint violations into HTTP 400s; that wiring is
// verified live, not here.)
describe('CreateBoxDto resource minimums', () => {
  it.each([
    ['cpus', { cpus: 0 }],
    ['memory_mib', { memory_mib: 128 }],
    ['disk_size_gb', { disk_size_gb: 0 }],
  ])('rejects undersized %s with a min constraint', async (field, body) => {
    const errors = await validate(plainToInstance(CreateBoxDto, body))

    const fieldError = errors.find((e) => e.property === field)
    expect(fieldError?.constraints).toHaveProperty('min')
  })

  it('accepts values exactly at the minimum boundary', async () => {
    const errors = await validate(plainToInstance(CreateBoxDto, { cpus: 1, memory_mib: 256, disk_size_gb: 1 }))

    expect(errors).toHaveLength(0)
  })

  it('accepts a request that omits resource fields (engine defaults)', async () => {
    const errors = await validate(plainToInstance(CreateBoxDto, { image: 'alpine:3.23' }))

    expect(errors).toHaveLength(0)
  })
})

describe('CreateBoxDto lifecycle policy', () => {
  it('accepts second-based lifecycle fields', async () => {
    const errors = await validate(plainToInstance(CreateBoxDto, { auto_pause: 900, auto_delete: 604800 }))

    expect(errors).toHaveLength(0)
  })

  it('accepts the auto-resume switch', async () => {
    const errors = await validate(plainToInstance(CreateBoxDto, { auto_resume: false }))

    expect(errors).toHaveLength(0)
  })

  it('rejects a non-boolean auto_resume', async () => {
    const errors = await validate(plainToInstance(CreateBoxDto, { auto_resume: 'false' }))

    expect(errors.find((error) => error.property === 'auto_resume')?.constraints).toHaveProperty('isBoolean')
  })

  it.each([
    ['auto_pause', -1],
    ['auto_delete', -2],
  ])('rejects invalid %s values', async (field, value) => {
    const errors = await validate(plainToInstance(CreateBoxDto, { [field]: value }))

    expect(errors.find((error) => error.property === field)?.constraints).toHaveProperty('min')
  })
})

describe('CreateBoxDto network validation', () => {
  it('accepts supported allow_net entry types', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: {
          mode: 'enabled',
          allow_net: ['api.openai.com', '*.anthropic.com', '192.168.1.1', '10.0.0.0/8'],
        },
      }),
    )

    expect(errors).toHaveLength(0)
  })

  it.each(['', 'https://api.openai.com', '*example.com', 'api..openai.com', '10.0.0.0/33', '999.0.0.1'])(
    'rejects invalid allow_net entry %s',
    async (entry) => {
      const errors = await validate(
        plainToInstance(CreateBoxDto, {
          network: {
            mode: 'enabled',
            allow_net: [entry],
          },
        }),
      )

      expect(JSON.stringify(errors)).toContain('isNetworkAllowEntry')
    },
  )

  it('rejects more than ten allow_net entries', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: {
          mode: 'enabled',
          allow_net: Array.from({ length: 11 }, (_, index) => `api-${index}.example.com`),
        },
      }),
    )

    expect(JSON.stringify(errors)).toContain('arrayMaxSize')
  })

  it('rejects unsupported network modes', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: { mode: 'public' },
      }),
    )

    expect(JSON.stringify(errors)).toContain('isIn')
  })
})

describe('CreateBoxDto capability validation', () => {
  it.each([
    ['advanced', { advanced: null }],
    ['advanced.capabilities', { advanced: { capabilities: null } }],
    ['advanced.capabilities.add', { advanced: { capabilities: { add: null } } }],
    ['advanced.capabilities.drop', { advanced: { capabilities: { drop: null } } }],
  ])('rejects explicit null for %s', async (_field, payload) => {
    const errors = await validate(plainToInstance(CreateBoxDto, payload))

    expect(errors).not.toHaveLength(0)
  })

  it('accepts Docker-style capability names', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        advanced: {
          capabilities: {
            add: ['sys_admin', 'CAP_NET_ADMIN', 'ALL'],
            drop: ['NET_RAW'],
          },
        },
      }),
    )

    expect(errors).toHaveLength(0)
  })

  it('accepts a syntactically valid capability that a newer guest may support', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        advanced: { capabilities: { add: ['FUTURE_KERNEL_FEATURE'] } },
      }),
    )

    expect(errors).toHaveLength(0)
  })

  it.each([
    ['advanced', 'advanced', { advanced: { capabilites: { drop: ['NET_RAW'] } } }],
    ['advanced.capabilities', 'capabilities', { advanced: { capabilities: { dorp: ['NET_RAW'] } } }],
  ])('rejects an unknown key under %s instead of ignoring it', async (_label, property, payload) => {
    const errors = await validate(plainToInstance(CreateBoxDto, payload))
    const flattened = [...errors, ...errors.flatMap((error) => error.children ?? [])]

    expect(flattened.find((error) => error.property === property)?.constraints).toHaveProperty(
      'hasNoUnknownCapabilityFields',
    )
  })

  it('rejects malformed capability names', async () => {
    for (const capability of ['NET-ADMIN', '123', 'ß']) {
      const errors = await validate(
        plainToInstance(CreateBoxDto, {
          advanced: { capabilities: { add: [capability] } },
        }),
      )

      expect(JSON.stringify(errors)).toContain('isLinuxCapabilityName')
    }
  })
})
