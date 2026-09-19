import { QueryRunner } from 'typeorm'
import { DropTemplateDeactivationTimeout1787200000000 } from './1787200000000-drop-template-deactivation-timeout-migration'

describe('DropTemplateDeactivationTimeout1787200000000', () => {
  const statement = 'ALTER TABLE "organization" DROP COLUMN IF EXISTS "template_deactivation_timeout_minutes"'

  /**
   * Post-deploy, not pre-deploy: during the deploy window the old API is still
   * running and still maps this column, so dropping it before the new one is
   * everywhere would break the version that is still serving.
   */
  it('drops the retired column idempotently', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner

    const migration = new DropTemplateDeactivationTimeout1787200000000()
    await migration.up(queryRunner)
    await migration.up(queryRunner)

    expect(queryRunner.query).toHaveBeenNthCalledWith(1, statement)
    expect(queryRunner.query).toHaveBeenNthCalledWith(2, statement)
  })
})
