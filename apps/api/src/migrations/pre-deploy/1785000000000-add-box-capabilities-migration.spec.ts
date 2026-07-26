import { QueryRunner } from 'typeorm'
import { AddBoxCapabilities1785000000000 } from './1785000000000-add-box-capabilities-migration'

describe('AddBoxCapabilities1785000000000', () => {
  it('stores advanced options as one nested JSONB object', async () => {
    const query = jest.fn().mockResolvedValue(undefined)
    const queryRunner = { query } as unknown as QueryRunner

    await new AddBoxCapabilities1785000000000().up(queryRunner)

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0][0]).toContain(`ADD "advanced" jsonb`)
    expect(query.mock.calls[0][0]).toContain(`{"capabilities":{"add":[],"drop":[]}}`)
    expect(query.mock.calls[1][0]).toContain(`ALTER TABLE "runner" ADD "features"`)
  })

  it('refuses to discard a persisted custom capability policy on rollback', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ hasCustomPolicy: true }])
    const queryRunner = { query } as unknown as QueryRunner

    await expect(new AddBoxCapabilities1785000000000().down(queryRunner)).rejects.toThrow(
      'custom Linux capability policies',
    )
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('SELECT EXISTS')
  })

  it('allows rollback when every box uses the baseline policy', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ hasCustomPolicy: false }])
    const queryRunner = { query } as unknown as QueryRunner

    await new AddBoxCapabilities1785000000000().down(queryRunner)

    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls.slice(1).map(([sql]) => sql)).toEqual([
      `ALTER TABLE "runner" DROP COLUMN "features"`,
      `ALTER TABLE "box" DROP COLUMN "advanced"`,
    ])
  })
})
