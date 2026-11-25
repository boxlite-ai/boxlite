/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { RegistriesService } from '../registry/services/registries.service'
import { BoxCostService } from '../usage/services/box-cost.service'
import { BoxliteCheckpointController } from './boxlite-checkpoint.controller'
import { BoxliteConfigController } from './boxlite-config.controller'
import { BoxliteDomainController } from './boxlite-domain.controller'
import { BoxliteImageController } from './boxlite-image.controller'
import { BoxliteRegistryController } from './boxlite-registry.controller'

const spec = parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8'))
// Ajv also implements OAS 3.0 nullable. Ignore that annotation to test the
// standard JSON Schema semantics required by this OAS 3.1 document.
const jsonSchema = JSON.parse(JSON.stringify(spec, (key, value) => (key === 'nullable' ? undefined : value)))
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
ajv.addSchema({ components: jsonSchema.components }, 'box-api')

function validator(name: string) {
  const validate = ajv.getSchema(`box-api#/components/schemas/${name}`)
  if (!validate) throw new Error(`Missing Box API schema: ${name}`)
  return validate
}

describe('Box API checkpoint schemas', () => {
  it('accepts omission or known kinds in a closed capture request', () => {
    const validate = validator('CreateCheckpointRequest')
    const request = { source_box_id: 'source' }
    expect(validate(request)).toBe(true)
    for (const kind of ['disk', 'full']) expect(validate({ ...request, kind })).toBe(true)
    for (const kind of [null, 'bogus', 123]) expect(validate({ ...request, kind })).toBe(false)
    expect(validate({ ...request, kind: 'full', extra: true })).toBe(false)
  })

  it('accepts omitted metadata and a known zero memory size, and rejects nulls and negative sizes', () => {
    const validate = validator('Checkpoint')
    const checkpoint = {
      id: 'checkpoint',
      name: 'backup',
      source_box_id: 'source',
      created_at: '2026-10-01T00:00:00Z',
      size_bytes: 512,
      state: 'ready',
    }
    expect(validate(checkpoint)).toBe(true)
    expect(validate({ ...checkpoint, kind: 'full', memory_size_bytes: 0 })).toBe(true)
    expect(validate({ ...checkpoint, kind: null })).toBe(false)
    expect(validate({ ...checkpoint, kind: 'full', memory_size_bytes: null })).toBe(false)
    expect(validate({ ...checkpoint, kind: 'full', memory_size_bytes: -1 })).toBe(false)
  })

  it('validates actual checkpoint and config controller responses', async () => {
    const record = {
      id: 'checkpoint',
      name: 'backup',
      sourceBoxId: 'source',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      state: 'creating',
    }
    const service = {
      create: jest.fn().mockResolvedValue(record),
      get: jest.fn().mockResolvedValue(record),
      list: jest.fn().mockResolvedValue({ checkpoints: [record] }),
    }
    const controller = new BoxliteCheckpointController(service as never)
    const auth = { organizationId: 'org-1' } as never
    expect(validator('Checkpoint')(await controller.create(auth, { source_box_id: 'source' }))).toBe(true)
    expect(validator('Checkpoint')(await controller.get(auth, 'checkpoint'))).toBe(true)
    const page = JSON.parse(JSON.stringify(await controller.list(auth)))
    expect(validator('CheckpointList')(page)).toBe(true)
    expect(validator('ServerConfig')(new BoxliteConfigController().getConfig())).toBe(true)
  })
})

describe('Box API cost schema', () => {
  it('validates actual accruing and final costs', async () => {
    const snapshot = {
      checkedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(0),
      unarchived: [],
      undelivered: [],
    }
    const price = jest.fn().mockResolvedValue({ lines: [], totalUsd: null })
    for (const ended of [false, true]) {
      const service = new BoxCostService(
        { query: async () => [{ ...snapshot, ended }] } as never,
        { price } as never,
        null,
      )
      const cost = await service.getCost('aB3cD4eF5gH6', 'org-1')
      expect(cost.total_usd).toBe(ended ? '0' : null)
      expect(validator('BoxCost')(cost)).toBe(true)
      expect(validator('BoxCost')({ ...cost, total_usd: 0 })).toBe(false)
    }
  })
})

describe('Box API JSON Schema nullability', () => {
  const nullableFields = {
    Principal: ['path_prefix', 'expires_at'],
    Box: ['name', 'pid'],
    ListBoxesResponse: ['next_page_token'],
    ExecutionInfo: ['exit_code', 'duration_ms', 'error_message'],
    BoxMetrics: [
      'cpu_percent',
      'memory_bytes',
      'network_bytes_sent',
      'network_bytes_received',
      'network_tcp_connections',
      'network_tcp_errors',
    ],
    BootTiming: [
      'total_create_ms',
      'guest_boot_ms',
      'filesystem_setup_ms',
      'image_prepare_ms',
      'guest_rootfs_ms',
      'box_config_ms',
      'box_spawn_ms',
      'container_init_ms',
    ],
    ImageInfo: ['size_bytes'],
    ImageVersion: ['size_bytes', 'last_used_at', 'upstream_missing_at'],
    ImageAliasEvent: ['from_digest', 'actor'],
    ListImagesResponse: ['next_page_token'],
    RegistryCredential: ['created_by'],
  }

  it.each(Object.entries(nullableFields).flatMap(([name, fields]) => fields.map((field) => [name, field])))(
    '%s.%s accepts null and its original type, rejecting other types',
    (name, field) => {
      const schema = jsonSchema.components.schemas[name].properties[field]
      const validate = ajv.compile(schema)
      expect(validate(null)).toBe(true)
      expect(validate(false)).toBe(false)
      expect(validate({})).toBe(false)
      const types = [schema.type].flat()
      if (types.includes('integer') || types.includes('number')) {
        expect(validate(42)).toBe(true)
        expect(validate('42')).toBe(false)
        if (types.includes('integer')) expect(validate(1.5)).toBe(false)
      } else {
        expect(validate(schema.format === 'date-time' ? '2026-10-01T00:00:00Z' : 'value')).toBe(true)
        expect(validate(42)).toBe(false)
        if (schema.format === 'date-time') expect(validate('invalid-time')).toBe(false)
      }
    },
  )

  it('validates actual image list and detail responses containing nulls', async () => {
    const recordedAt = new Date('2026-10-01T00:00:00Z')
    const catalog = {
      listReferences: jest.fn().mockResolvedValue([
        {
          reference: 'quay.io/acme/app:v1',
          name: 'quay.io/acme/app',
          tag: 'v1',
          digest: 'sha256:aa',
          recordedAt,
          sizeBytes: null,
        },
      ]),
      get: jest.fn().mockResolvedValue({
        name: 'quay.io/acme/app',
        aliases: ['v1'],
        curated: false,
        versions: [
          {
            digest: 'sha256:aa',
            sourceRef: 'quay.io/acme/app:v1',
            createdAt: recordedAt.toISOString(),
            aliases: ['v1'],
            sizeBytes: null,
            lastUsedAt: null,
            upstreamMissingAt: null,
          },
        ],
        history: [
          {
            aliasName: 'v1',
            fromDigest: null,
            toDigest: 'sha256:aa',
            actorId: null,
            createdAt: recordedAt.toISOString(),
          },
        ],
      }),
    }
    const controller = new BoxliteImageController(catalog as unknown as ImageCatalogService)
    const caller = { organization: { id: 'org-1' } } as never
    const list = JSON.parse(JSON.stringify(await controller.list(caller)))
    const detail = JSON.parse(JSON.stringify(await controller.get(caller, 'quay.io/acme/app')))

    expect(validator('ListImagesResponse')(list)).toBe(true)
    const validate = validator('ImageDetail')
    expect(validate(detail)).toBe(true)
    expect(validate({ ...detail, versions: [{ ...detail.versions[0], size_bytes: 'unknown' }] })).toBe(false)
  })

  it('validates an actual domain list with a bound and an unbound domain', async () => {
    const domains = {
      listHeld: jest.fn().mockResolvedValue({
        domains: [
          {
            hostname: 'demo1.app.test',
            kind: 'platform',
            url: 'https://demo1.app.test',
            target: { type: 'box', box: 'box-1', port: 3000 },
          },
          { hostname: 'spare.app.test', kind: 'platform', url: 'https://spare.app.test', target: null },
          {
            hostname: 'shop.app.test',
            kind: 'platform',
            url: 'https://shop.app.test',
            target: { type: 'app', app: 'shop' },
          },
        ],
        limit: 3,
        used: 3,
        remaining: 0,
        minLength: 5,
        domainSuffix: 'app.test',
      }),
    }
    const controller = new BoxliteDomainController(domains as never, {} as never)
    const list = JSON.parse(JSON.stringify(await controller.list({ organizationId: 'org-1' } as never)))

    const validate = validator('DomainList')
    expect(validate(list)).toBe(true)
    expect(validate({ ...list, domains: [{ ...list.domains[0], target: { type: 'app', box: 'b', port: 1 } }] })).toBe(
      false,
    )
  })

  it('validates actual registry responses without a creating user', async () => {
    const credential = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      registryHost: 'quay.io',
      repositoryPrefix: '',
      username: 'robot',
      createdBy: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    }
    const registries = { list: jest.fn().mockResolvedValue([credential]) }
    const controller = new BoxliteRegistryController(registries as unknown as RegistriesService)
    const response = JSON.parse(JSON.stringify(await controller.list({ organizationId: 'org-1' } as never)))
    expect(validator('ListRegistriesResponse')(response)).toBe(true)
  })

  it.each([
    [
      'ImageVersion',
      { digest: 'sha256:aa', source_ref: 'quay.io/acme/app:v1', recorded_at: '2026-10-01T00:00:00Z' },
      'digest',
    ],
    ['ImageAliasEvent', { alias: 'v1', to_digest: 'sha256:aa', recorded_at: '2026-10-01T00:00:00Z' }, 'to_digest'],
    [
      'RegistryCredential',
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        registry_host: 'quay.io',
        repository_prefix: '',
        username: 'robot',
        created_at: '2026-10-01T00:00:00Z',
      },
      'id',
    ],
    ['ListImagesResponse', { images: [] }, 'images'],
  ])(
    '%s keeps nullable fields optional and required fields non-null',
    (name: string, minimal: object, required: string) => {
      const validate = validator(name)
      expect(validate(minimal)).toBe(true)
      expect(validate({ ...minimal, [required]: null })).toBe(false)
      const missing = { ...minimal }
      delete missing[required]
      expect(validate(missing)).toBe(false)
    },
  )
})
