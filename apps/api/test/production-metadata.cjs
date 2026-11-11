// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Socket } = require('node:net')
const { NestFactory } = require('@nestjs/core')
const { DataSource, getMetadataArgsStorage } = require('typeorm')

test('production API bundle has valid PostgreSQL entity metadata', { timeout: 15000 }, async (t) => {
  process.env.OTEL_ENABLED = 'false'
  delete process.env.CERT_PATH
  delete process.env.CERT_KEY_PATH
  t.mock.method(Socket.prototype, 'connect', () => assert.fail('Metadata validation must not open a network connection'))
  // Load the shipped entrypoint, but stop before Nest initializes services.
  // An unresolved promise holds bootstrap here without keeping Node alive.
  const create = t.mock.method(NestFactory, 'create', () => new Promise(() => {}))
  require('../../dist/apps/api/main.js')
  assert.equal(create.mock.callCount(), 1, 'The production entrypoint must reach Nest application creation')

  const entities = [...new Set(getMetadataArgsStorage().tables.map((table) => table.target))]
  assert.ok(entities.length > 0, 'The bundle must register entities')
  const dataSource = new DataSource({ type: 'postgres', entities, entitySkipConstructor: true })
  // This is the same metadata builder/validator initialize() uses, without a connection.
  await dataSource.buildMetadatas()

  const checkpoint = dataSource.getMetadata('checkpoint')
  const sourceState = checkpoint.findColumnWithPropertyName('sourceState')
  assert.ok(sourceState, 'The checkpoint source state column must be present')
  assert.equal(dataSource.driver.normalizeType(sourceState), 'character varying')
  console.log(`Validated PostgreSQL metadata for ${dataSource.entityMetadatas.length} production entities`)
})
