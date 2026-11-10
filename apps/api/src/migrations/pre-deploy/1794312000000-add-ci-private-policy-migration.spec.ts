/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddCiConnect1793664000000 } from './1793664000000-add-ci-connect-migration'
import { AddCiListenerState1793700000000 } from './1793700000000-add-ci-listener-state-migration'
import { AddCiPrivatePolicy1794312000000 } from './1794312000000-add-ci-private-policy-migration'

const url = process.env.CI_CONNECT_TEST_DATABASE_URL
;(url ? describe : describe.skip)('CI Private policy empty-state cutover (real Postgres)', () => {
  const schema = 'ci_private_' + randomUUID().replaceAll('-', ''),
    organization = randomUUID(),
    migration = new AddCiPrivatePolicy1794312000000()
  let db: DataSource
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
      throw new Error('Disposable local database required')
    db = await new DataSource({ type: 'postgres', url, extra: { options: `-c search_path=${schema}` } }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
  })
  beforeEach(async () => {
    await db.query('CREATE TABLE organization(id uuid PRIMARY KEY)')
    await db.query('INSERT INTO organization VALUES($1)', [organization])
    const runner = db.createQueryRunner()
    try {
      await new AddCiConnect1793664000000().up(runner)
      await new AddCiListenerState1793700000000().up(runner)
    } finally {
      await runner.release()
    }
  })
  afterEach(async () => {
    await db.query('DROP TABLE ci_connect_attempt,ci_installation_binding,ci_listener_state,organization')
  })
  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  it.each(['binding', 'attempt', 'journal'])('rejects legacy %s state without altering old consent', async (kind) => {
    if (kind === 'binding')
      await db.query(
        `INSERT INTO ci_installation_binding(id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation,allow_public)
      VALUES($1,'github.com','app',11,7,'owner','User',$2,'actor',true,true)`,
        [randomUUID(), organization],
      )
    if (kind === 'attempt')
      await db.query(
        `INSERT INTO ci_connect_attempt(id,organization_id,user_id,github_account,allow_public,app_client_id,expires_at,next_poll_at,interval_seconds)
      VALUES($1,$2,'actor','owner',true,'app',now()+interval '1 minute',now(),1)`,
        [randomUUID(), organization],
      )
    if (kind === 'journal')
      await db.query(
        `INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload) VALUES('ci:app','backend/native',$1,1,'{}')`,
        [randomUUID()],
      )
    const runner = db.createQueryRunner()
    try {
      await expect(migration.up(runner)).rejects.toThrow('Finish CI resource cleanup')
    } finally {
      await runner.release()
    }
    expect(
      await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='ci_installation_binding' AND column_name='allow_public'`,
        [schema],
      ),
    ).toHaveLength(1)
    expect(
      (
        await db.query(
          `SELECT count(*) FROM ${kind === 'binding' ? 'ci_installation_binding' : kind === 'attempt' ? 'ci_connect_attempt' : 'ci_listener_state'}`,
        )
      )[0].count,
    ).toBe('1')
  })
  it('renames empty stores with Private disabled by default and protects rollback after new consent is saved', async () => {
    const runner = db.createQueryRunner()
    try {
      await migration.up(runner)
      await db.query(
        `INSERT INTO ci_installation_binding(id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation)
        VALUES($1,'github.com','app',11,7,'owner','User',$2,'actor',true)`,
        [randomUUID(), organization],
      )
      expect((await db.query('SELECT allow_private FROM ci_installation_binding'))[0].allow_private).toBe(false)
      await expect(migration.down(runner)).rejects.toThrow('Finish CI resource cleanup')
      await db.query('DELETE FROM ci_installation_binding')
      await migration.down(runner)
      expect(
        await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='ci_connect_attempt' AND column_name='allow_public'`,
          [schema],
        ),
      ).toHaveLength(1)
    } finally {
      await runner.release()
    }
  })
})
