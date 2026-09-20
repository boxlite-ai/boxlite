import { QueryRunner } from 'typeorm'
import { AddBoxImageOwnership1787300000000 } from './1787300000000-add-box-image-ownership-migration'

describe('AddBoxImageOwnership1787300000000', () => {
  const runMigration = async (direction: 'up' | 'down') => {
    const query = jest.fn().mockResolvedValue(undefined)
    await new AddBoxImageOwnership1787300000000()[direction]({ query } as unknown as QueryRunner)
    return query.mock.calls.map((call) => call[0] as string)
  }

  it('adds the column as nullable', async () => {
    expect(await runMigration('up')).toEqual([`ALTER TABLE "box" ADD "imageIsOrgOwned" boolean`])
  })

  /**
   * Not a style preference. A `NOT NULL DEFAULT` would claim every existing box
   * was decided one way, and the reader distinguishes "recorded false" from
   * "never recorded" — the second is what keeps old rows on the behaviour they
   * have always had instead of silently changing which ones pull anonymously.
   */
  it('backfills nothing and defaults to nothing', async () => {
    const sql = (await runMigration('up')).join('\n')

    expect(sql).not.toMatch(/DEFAULT/i)
    expect(sql).not.toMatch(/NOT NULL/i)
    expect(sql).not.toMatch(/UPDATE/i)
  })

  it('drops the column on the way down', async () => {
    expect(await runMigration('down')).toEqual([`ALTER TABLE "box" DROP COLUMN "imageIsOrgOwned"`])
  })
})
