/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddCiListenerState1793700000000 } from './1793700000000-add-ci-listener-state-migration'

const url = process.env.CI_CONNECT_TEST_DATABASE_URL
const integration = url ? describe : describe.skip
integration('CI state rollback protection (real Postgres)', () => {
  const schema = 'ci_rollback_' + randomUUID().replaceAll('-', '')
  const migration = new AddCiListenerState1793700000000()
  let db: DataSource
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
      throw new Error('Disposable local database required')
    db = await new DataSource({ type: 'postgres', url, extra: { options: `-c search_path=${schema}` } }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
  })
  beforeEach(async () => {
    const runner = db.createQueryRunner()
    try {
      await migration.up(runner)
    } finally {
      await runner.release()
    }
  })
  afterEach(async () => {
    await db.query('DROP TABLE IF EXISTS ci_listener_state')
  })
  afterAll(async () => {
    if (!db?.isInitialized) return
    try {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await db.destroy()
    }
  })
  it.each(['worker/original', 'box-native/original', 'credential/original', 'backend/native'])(
    'preserves %s instead of silently dropping its cleanup state',
    async (key) => {
      await db.query(
        `INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload)
        VALUES ('test',$1,$2,1,'{"box":"original"}')`,
        [key, randomUUID()],
      )
      const runner = db.createQueryRunner()
      try {
        await expect(migration.down(runner)).rejects.toThrow('CI Listener state must be empty before rollback')
        expect((await db.query('SELECT record_key FROM ci_listener_state')).map((row) => row.record_key)).toEqual([key])
      } finally {
        await runner.release()
      }
    },
  )
  it('allows rollback of an empty state table', async () => {
    const runner = db.createQueryRunner()
    try {
      await migration.down(runner)
    } finally {
      await runner.release()
    }
    expect((await db.query("SELECT to_regclass('ci_listener_state') AS name"))[0].name).toBeNull()
  })
})
