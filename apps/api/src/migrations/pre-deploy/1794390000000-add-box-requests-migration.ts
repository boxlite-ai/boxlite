import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxRequests1794390000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE box_request (
      scope text PRIMARY KEY,
      hash text NOT NULL,
      token uuid NOT NULL DEFAULT gen_random_uuid(),
      "boxId" text,
      response jsonb,
      "expiresAt" timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
    )`)
    await queryRunner.query(
      'CREATE INDEX box_request_expiry ON box_request ("expiresAt") WHERE "expiresAt" IS NOT NULL',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE box_request')
  }
}
