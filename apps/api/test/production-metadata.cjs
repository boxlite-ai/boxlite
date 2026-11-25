// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { test } = require('node:test')
const { Socket } = require('node:net')
const { join } = require('node:path')
const { globSync } = require('glob')
const { NestFactory } = require('@nestjs/core')
const { DataSource, getMetadataArgsStorage } = require('typeorm')

test('production API bundle includes every timestamped migration', () => {
  const expected = globSync('**/[0-9]*.ts', {
    cwd: join(__dirname, '../src/migrations'),
    ignore: '**/*.spec.ts',
  }).map((file) => file.split('/').at(-1).replace(/\.ts$/, '.js'))
  const bundled = globSync('*-migration.js', { cwd: join(__dirname, '../../dist/apps/api/migrations') })

  assert.ok(expected.length > 0)
  assert.deepEqual(bundled.sort(), expected.sort())
})

test('the shipped migration CLI reports exactly the source identities for each phase', () => {
  const source = join(__dirname, '../src/migrations')
  const cli = join(__dirname, '../../dist/apps/api/migrate.js')
  for (const phase of ['all', 'pre-deploy', 'post-deploy']) {
    const pattern = phase === 'all' ? '**/*-migration.ts' : `${phase}/*-migration.ts`
    const expected = globSync(pattern, { cwd: source }).map((file) => {
      const match = readFileSync(join(source, file), 'utf8').match(/export class (\w+\d{13})\b/)
      assert.ok(match, file)
      return match[1]
    })
    const output = execFileSync(process.execPath, [cli, 'list', phase], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(output), expected.sort(), phase)
  }
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'run', 'post-deploy'], { stdio: 'pipe' }),
    /Post-deploy requires --old-replicas-retired/,
  )
})

test('production API bundle has valid PostgreSQL entity metadata', { timeout: 15000 }, async (t) => {
  process.env.OTEL_ENABLED = 'false'
  delete process.env.CERT_PATH
  delete process.env.CERT_KEY_PATH
  t.mock.method(Socket.prototype, 'connect', () =>
    assert.fail('Metadata validation must not open a network connection'),
  )
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
