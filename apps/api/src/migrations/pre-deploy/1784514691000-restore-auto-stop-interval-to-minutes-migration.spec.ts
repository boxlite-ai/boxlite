import { QueryRunner } from 'typeorm'
import { RestoreAutoStopIntervalToMinutes1784514691000 } from './1784514691000-restore-auto-stop-interval-to-minutes-migration'

describe('RestoreAutoStopIntervalToMinutes1784514691000', () => {
  it('converts existing second values back to minutes and restores the minute default', async () => {
    const queries: string[] = []
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql)
      },
    } as unknown as QueryRunner

    await new RestoreAutoStopIntervalToMinutes1784514691000().up(queryRunner)

    expect(queries).toEqual([
      'UPDATE "box" SET "autoStopInterval" = "autoStopInterval" / 60',
      `ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '15'`,
    ])
  })

  it('restores second values and the seconds default on rollback', async () => {
    const queries: string[] = []
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql)
      },
    } as unknown as QueryRunner

    await new RestoreAutoStopIntervalToMinutes1784514691000().down(queryRunner)

    expect(queries).toEqual([
      'UPDATE "box" SET "autoStopInterval" = "autoStopInterval" * 60',
      `ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '900'`,
    ])
  })
})
