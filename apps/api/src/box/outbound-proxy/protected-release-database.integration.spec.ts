import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { fenceFormerProtectedApiLogin, prepareProtectedApiLogin } from './protected-release-database'

const describeWithDb = process.env.DB_HOST ? describe : describe.skip

describeWithDb('protected API database login cutover (PostgreSQL)', () => {
  it('keeps object ownership and recovers repeated fencing with a former write in flight', async () => {
    const suffix = randomBytes(8).toString('hex')
    const former = { user: `former_${suffix}`, password: randomBytes(20).toString('hex') }
    const runtime = { user: `runtime_${suffix}`, password: randomBytes(20).toString('hex') }
    const db = {
      host: process.env.DB_HOST,
      database: process.env.DB_DATABASE,
      administrator: { user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD ?? '' },
      former,
      runtime,
    }
    const scope = { host: db.host, database: db.database }
    const admin = new Client({ ...scope, ...db.administrator })
    const previous = new Client({ ...scope, ...former })
    const current = new Client({ ...scope, ...runtime })
    previous.on('error', () => undefined)
    await admin.connect()
    try {
      await admin.query(`CREATE ROLE ${former.user} LOGIN PASSWORD '${former.password}'`)
      await admin.query(`CREATE SCHEMA stage_${suffix} AUTHORIZATION ${former.user}`)
      await previous.connect()
      await previous.query(`CREATE TABLE stage_${suffix}.jobs (id text PRIMARY KEY)`)
      await previous.query('BEGIN')
      await previous.query(`INSERT INTO stage_${suffix}.jobs VALUES ('old-uncommitted')`)

      await prepareProtectedApiLogin(db)
      await current.connect()
      await current.query(`INSERT INTO stage_${suffix}.jobs VALUES ('current')`)
      await fenceFormerProtectedApiLogin(db)
      await fenceFormerProtectedApiLogin(db)

      await expect(previous.query('COMMIT')).rejects.toThrow()
      await current.query(`CREATE TABLE stage_${suffix}.new_objects (id text)`)
      expect((await current.query(`SELECT id FROM stage_${suffix}.jobs`)).rows).toEqual([{ id: 'current' }])
      expect(
        (
          await admin.query("SELECT tableowner FROM pg_tables WHERE schemaname = $1 AND tablename = 'new_objects'", [
            `stage_${suffix}`,
          ])
        ).rows,
      ).toEqual([{ tableowner: former.user }])
    } finally {
      await previous.end().catch(() => undefined)
      await current.end().catch(() => undefined)
      await admin.query(`DROP SCHEMA IF EXISTS stage_${suffix} CASCADE`)
      await admin.query(`DROP ROLE IF EXISTS ${runtime.user}`)
      await admin.query(`DROP ROLE IF EXISTS ${former.user}`)
      await admin.end()
    }
  })
})
