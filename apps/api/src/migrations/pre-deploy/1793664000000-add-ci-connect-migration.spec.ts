/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddCiConnect1793664000000 } from './1793664000000-add-ci-connect-migration'

const url = process.env.CI_CONNECT_TEST_DATABASE_URL
;(url ? describe : describe.skip)('CI connection initial schema (real Postgres)', () => {
  const schema = 'ci_initial_' + randomUUID().replaceAll('-', '')
  const organization = randomUUID()
  let db: DataSource
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
      throw new Error('Disposable local database required')
    db = await new DataSource({ type: 'postgres', url, extra: { options: `-c search_path=${schema}` } }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query('CREATE TABLE organization(id uuid PRIMARY KEY)')
    await db.query('INSERT INTO organization VALUES($1)', [organization])
    const runner = db.createQueryRunner()
    try {
      await new AddCiConnect1793664000000().up(runner)
    } finally {
      await runner.release()
    }
  })
  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it.each(['ci_installation_binding', 'ci_connect_attempt'])(
    'creates %s with Private disabled by default',
    async (table) => {
      expect(
        await db.query(
          `SELECT column_name,column_default,is_nullable FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 AND column_name IN ('allow_private','allow_public')`,
          [schema, table],
        ),
      ).toEqual([{ column_name: 'allow_private', column_default: 'false', is_nullable: 'NO' }])
      if (table === 'ci_installation_binding')
        await db.query(
          `INSERT INTO ci_installation_binding(id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation)
        VALUES($1,'github.com','app',11,7,'owner','User',$2,'actor',true)`,
          [randomUUID(), organization],
        )
      else
        await db.query(
          `INSERT INTO ci_connect_attempt(id,organization_id,user_id,github_account,app_client_id,expires_at,next_poll_at,interval_seconds)
        VALUES($1,$2,'actor','owner','app',now()+interval '1 minute',now(),1)`,
          [randomUUID(), organization],
        )
      expect((await db.query(`SELECT allow_private FROM ${table}`))[0].allow_private).toBe(false)
    },
  )
})
