import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Expand-phase migration: persist each box's guest SSH CA trust bundle.
 *
 * Purely additive and nullable. Existing rows get NULL, which reads as "this
 * VM generation has no SSH listener" — the correct answer for boxes created
 * before the organization had a CA.
 */
export class AddBoxGuestSshTrust1785041600000 implements MigrationInterface {
  name = 'AddBoxGuestSshTrust1785041600000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "guestSshTrust" jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "guestSshTrust"`)
  }
}
