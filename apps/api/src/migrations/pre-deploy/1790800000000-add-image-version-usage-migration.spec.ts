import { QueryRunner } from 'typeorm'
import { AddImageVersionUsage1790800000000 } from './1790800000000-add-image-version-usage-migration'

describe('AddImageVersionUsage1790800000000', () => {
  const runMigration = async (direction: 'up' | 'down') => {
    const query = jest.fn().mockResolvedValue(undefined)
    await new AddImageVersionUsage1790800000000()[direction]({ query } as unknown as QueryRunner)
    return query.mock.calls.map((call) => call[0] as string)
  }

  /**
   * A default would stamp every version already recorded with the moment the
   * migration ran, which reads as a use nobody made and a disappearance
   * nobody saw. Null is the honest "not recorded yet".
   */
  it('adds both columns nullable and without a default', async () => {
    const statements = await runMigration('up')

    expect(statements).toEqual([
      `ALTER TABLE "image_version" ADD "lastUsedAt" TIMESTAMP WITH TIME ZONE`,
      `ALTER TABLE "image_version" ADD "upstreamMissingAt" TIMESTAMP WITH TIME ZONE`,
    ])
  })

  it('drops exactly what it added', async () => {
    const statements = await runMigration('down')

    expect(statements).toEqual([
      `ALTER TABLE "image_version" DROP COLUMN "upstreamMissingAt"`,
      `ALTER TABLE "image_version" DROP COLUMN "lastUsedAt"`,
    ])
  })
})
