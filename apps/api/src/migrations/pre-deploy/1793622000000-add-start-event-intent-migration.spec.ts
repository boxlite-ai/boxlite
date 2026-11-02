import { DataSource } from 'typeorm'
import { AddStartEventIntent1793622000000 } from './1793622000000-add-start-event-intent-migration'

const databaseUrl = process.env.BOXLITE_TEST_POSTGRES_URL

;(databaseUrl ? describe : describe.skip)('Start event intent migration', () => {
  it('defaults existing and new rows to false and reverses on PostgreSQL', async () => {
    const source = await new DataSource({ type: 'postgres', url: databaseUrl }).initialize()
    const runner = source.createQueryRunner()
    try {
      await runner.startTransaction()
      await runner.query('CREATE TEMP TABLE "box" (id text PRIMARY KEY) ON COMMIT DROP')
      await runner.query("INSERT INTO box (id) VALUES ('existing')")
      const migration = new AddStartEventIntent1793622000000()
      await migration.up(runner)
      await runner.query("INSERT INTO box (id) VALUES ('new')")
      expect(await runner.query('SELECT "startEventPending" FROM box ORDER BY id')).toEqual([
        { startEventPending: false },
        { startEventPending: false },
      ])
      await runner.query('UPDATE box SET "startEventPending" = true')
      await migration.down(runner)
      expect(await runner.query('SELECT * FROM box ORDER BY id')).toEqual([{ id: 'existing' }, { id: 'new' }])
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
      await source.destroy()
    }
  })
})
