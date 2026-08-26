/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
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
    const errors = await validate(plainToInstance(CreateBoxDto, { auto_stop: 900, auto_delete: 604800 }))

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
    ['auto_stop', -1],
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
          outbound: {
            mode: 'enabled',
            allow_net: ['api.openai.com', '*.anthropic.com', '192.168.1.1', '10.0.0.0/8'],
          },
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
            outbound: {
              mode: 'enabled',
              allow_net: [entry],
            },
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
          outbound: {
            mode: 'enabled',
            allow_net: Array.from({ length: 11 }, (_, index) => `api-${index}.example.com`),
          },
        },
      }),
    )

    expect(JSON.stringify(errors)).toContain('arrayMaxSize')
  })

  it('rejects unsupported network modes', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: { outbound: { mode: 'public' } },
      }),
    )

    expect(JSON.stringify(errors)).toContain('isIn')
  })

  it.each([
    ['mode', { mode: 'disabled' }, { outbound: { mode: 'disabled' } }],
    ['allow_net', { allow_net: ['api.openai.com'] }, { outbound: { mode: 'enabled', allow_net: ['api.openai.com'] } }],
  ])('accepts deprecated legacy flat network.%s, normalized to %j', async (_field, network, expected) => {
    const instance = plainToInstance(CreateBoxDto, { network })
    const errors = await validate(instance)

    expect(errors).toEqual([])
    expect(instance.network).toMatchObject(expected)
  })

  it('rejects legacy flat fields mixed with nested outbound/inbound', () => {
    expect(() =>
      plainToInstance(CreateBoxDto, {
        network: { mode: 'enabled', outbound: { mode: 'disabled' } },
      }),
    ).toThrow('network must not mix legacy top-level fields with nested outbound/inbound fields')
  })

  // `network: []` is deliberately absent here: it was accepted before the
  // split and stays accepted (see the request-pipeline tests below).
  it.each([
    ['network', [{ mode: 'enabled' }]],
    ['network.outbound', { outbound: [] }],
    ['network.inbound', { inbound: [] }],
  ])('rejects array-valued %s', async (_field, network) => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network,
      }),
    )

    expect(JSON.stringify(errors)).toContain('isObject')
  })

  it.each(['enabled', 'disabled'])('accepts inbound.mode=%s', async (mode) => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: { outbound: { mode: 'enabled' }, inbound: { mode } },
      }),
    )

    expect(errors).toHaveLength(0)
  })

  it('rejects unsupported inbound.mode values', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: { outbound: { mode: 'enabled' }, inbound: { mode: 'shared' } },
      }),
    )

    expect(JSON.stringify(errors)).toContain('isIn')
  })

  // No layer enforces an inbound allowlist yet, so a non-empty allow_net
  // is rejected outright — under either mode — rather than accepted as a
  // restriction that silently doesn't apply.
  it.each(['enabled', 'disabled'])('rejects a non-empty inbound.allow_net under mode=%s', async (mode) => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: {
          outbound: { mode: 'enabled' },
          inbound: { mode, allow_net: ['10.0.0.0/8'] },
        },
      }),
    )

    expect(JSON.stringify(errors)).toContain('isUnsupportedInboundAllowNet')
  })

  it('accepts an explicitly empty inbound.allow_net', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        network: {
          outbound: { mode: 'enabled' },
          inbound: { mode: 'enabled', allow_net: [] },
        },
      }),
    )

    expect(errors).toHaveLength(0)
  })
})

describe('CreateBoxDto managed volumes', () => {
  function getReadOnlyConstraints(errors: Awaited<ReturnType<typeof validate>>) {
    return errors
      .find((error) => error.property === 'volumes')
      ?.children?.[0]?.children?.find((error) => error.property === 'read_only')?.constraints
  }

  it('accepts a managed volume mount by id and by name', async () => {
    for (const managed_volume of ['volume-123', 'customer-data']) {
      const errors = await validate(
        plainToInstance(CreateBoxDto, {
          volumes: [{ managed_volume, guest_path: '/data', read_only: false }],
        }),
      )

      expect(errors).toHaveLength(0)
    }
  })

  it('rejects a volume mount with no managed_volume', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        volumes: [{ guest_path: '/data', read_only: false }],
      }),
    )

    expect(JSON.stringify(errors)).toContain('isString')
  })

  it('rejects an empty managed_volume', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        volumes: [{ managed_volume: '', guest_path: '/data' }],
      }),
    )

    expect(JSON.stringify(errors)).toContain('isNotEmpty')
  })

  // This API mounts managed volumes only. A path here would name the server's
  // filesystem, so it gets a message that says so rather than a "not found"
  // for a volume the caller never meant to reference.
  it.each(['/host/data', './data', '../data', '~/data', 'C:\\data', 'D:/data', '\\\\server\\share'])(
    'rejects the host path %s with a host-bind message',
    async (managed_volume) => {
      const errors = await validate(
        plainToInstance(CreateBoxDto, {
          volumes: [{ managed_volume, guest_path: '/data' }],
        }),
      )

      expect(JSON.stringify(errors)).toContain('host bind mounts are not supported')
    },
  )

  it('still accepts a name that merely contains a dot or dash', async () => {
    for (const managed_volume of ['my.data', 'my-data', 'a.b-c_d']) {
      const errors = await validate(
        plainToInstance(CreateBoxDto, {
          volumes: [{ managed_volume, guest_path: '/data' }],
        }),
      )

      expect(errors).toHaveLength(0)
    }
  })

  it('rejects read-only cloud volume mounts until the backend supports them', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        volumes: [{ managed_volume: 'volume-123', guest_path: '/data', read_only: true }],
      }),
    )

    expect(getReadOnlyConstraints(errors)).toHaveProperty('isIn')
  })

  it('rejects null read_only values', async () => {
    const errors = await validate(
      plainToInstance(CreateBoxDto, {
        volumes: [{ managed_volume: 'volume-123', guest_path: '/data', read_only: null }],
      }),
    )

    expect(getReadOnlyConstraints(errors)).toHaveProperty('isIn')
  })
})

// The DTO-level cases above call plainToInstance directly. This block drives
// the same ValidationPipe main.ts installs, so it proves an already-deployed
// client's request survives the whole request pipeline — the DTO shape
// changed, the accepted wire format did not.
describe('CreateBoxDto legacy network compatibility through the request pipeline', () => {
  const pipe = new ValidationPipe({ transform: true })
  const meta = { type: 'body' as const, metatype: CreateBoxDto }

  it('accepts the pre-split flat shape and normalizes it to outbound', async () => {
    const dto: CreateBoxDto = await pipe.transform(
      { image: 'alpine:latest', network: { mode: 'enabled', allow_net: ['api.openai.com'] } },
      meta,
    )

    expect(dto.network?.outbound?.mode).toBe('enabled')
    expect(dto.network?.outbound?.allow_net).toEqual(['api.openai.com'])
  })

  it('accepts the pre-split flat disabled mode', async () => {
    const dto: CreateBoxDto = await pipe.transform({ image: 'alpine:latest', network: { mode: 'disabled' } }, meta)

    expect(dto.network?.outbound?.mode).toBe('disabled')
  })

  it('accepts the nested shape', async () => {
    const dto: CreateBoxDto = await pipe.transform(
      { image: 'alpine:latest', network: { outbound: { mode: 'disabled' }, inbound: { mode: 'disabled' } } },
      meta,
    )

    expect(dto.network?.outbound?.mode).toBe('disabled')
    expect(dto.network?.inbound?.mode).toBe('disabled')
  })

  // The one payload the added @IsObject() would otherwise have started
  // rejecting: an empty array passed the old @ValidateNested()-only field and
  // behaved like an absent `network`.
  it('still accepts an empty array for network, treating it as absent', async () => {
    const dto: CreateBoxDto = await pipe.transform({ image: 'alpine:latest', network: [] }, meta)

    expect(dto.network).toBeUndefined()
  })

  it('rejects a non-empty array for network, as before', async () => {
    await expect(pipe.transform({ image: 'alpine:latest', network: [{ mode: 'enabled' }] }, meta)).rejects.toThrow()
  })
})
