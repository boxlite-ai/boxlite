/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

type OpenApiSchema = {
  description?: string
  additionalProperties?: boolean | OpenApiSchema
  minimum?: number
  properties?: Record<string, OpenApiSchema>
}

type OpenApiDocument = {
  components: {
    schemas: Record<string, OpenApiSchema>
  }
}

const specPath = resolve(__dirname, '../../../../openapi/box.openapi.yaml')
const document = parse(readFileSync(specPath, 'utf8')) as OpenApiDocument
const schemas = document.components.schemas

describe('published Apps REST contract', () => {
  it('publishes the exact implemented create allowlist as a closed object', () => {
    const create = schemas.CreateBoxRequest

    expect(create.additionalProperties).toBe(false)
    expect(Object.keys(create.properties ?? {}).sort()).toEqual(
      [
        'name',
        'image',
        'cpus',
        'memory_mib',
        'disk_size_gb',
        'env',
        'user',
        'network',
        'auto_pause',
        'auto_delete',
        'auto_resume',
      ].sort(),
    )
    expect(create.description).not.toContain('BoxOptions')
    expect(create.properties?.memory_mib.minimum).toBe(256)
  })

  it.each(['VolumeSpec', 'PortSpec', 'SecretSpec', 'SecurityPreset'])(
    'does not publish host/runtime create component %s',
    (schemaName) => {
      expect(schemas).not.toHaveProperty(schemaName)
    },
  )

  it('does not publish runner-host process details in Box responses', () => {
    const box = schemas.Box

    expect(box.properties).not.toHaveProperty('pid')
    expect(box.description).not.toContain('BoxInfo')
    expect(box.properties?.image.description).not.toMatch(/rootfs|host path/i)
  })
})
