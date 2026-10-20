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
