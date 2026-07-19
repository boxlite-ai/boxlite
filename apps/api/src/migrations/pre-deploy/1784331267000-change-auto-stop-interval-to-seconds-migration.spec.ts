import { QueryRunner } from 'typeorm'
import { ChangeAutoStopIntervalToSeconds1784331267000 } from './1784331267000-change-auto-stop-interval-to-seconds-migration'

describe('ChangeAutoStopIntervalToSeconds1784331267000', () => {
  it('converts existing minute values before the column default changes', async () => {
    const queries: string[] = []
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql)
      },
    } as unknown as QueryRunner

    await new ChangeAutoStopIntervalToSeconds1784331267000().up(queryRunner)

    expect(queries).toEqual([
      'UPDATE "box" SET "autoStopInterval" = "autoStopInterval" * 60',
      `ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '900'`,
    ])
  })

  it('restores minute values and the previous default on rollback', async () => {
    const queries: string[] = []
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql)
      },
    } as unknown as QueryRunner

    await new ChangeAutoStopIntervalToSeconds1784331267000().down(queryRunner)

    expect(queries).toEqual([
      'UPDATE "box" SET "autoStopInterval" = "autoStopInterval" / 60',
      `ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '15'`,
    ])
  })
})
