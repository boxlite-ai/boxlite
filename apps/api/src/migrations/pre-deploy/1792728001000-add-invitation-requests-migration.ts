import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddInvitationRequests1792728001000 implements MigrationInterface {
  name = 'AddInvitationRequests1792728001000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE organization_invitation_request (
      "organizationId" uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      "userId" text NOT NULL,
      key uuid NOT NULL,
      "requestHash" text NOT NULL,
      response jsonb NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      PRIMARY KEY ("organizationId", "userId", key)
    )`)
    await queryRunner.query(
      'CREATE INDEX organization_invitation_request_expiry ON organization_invitation_request ("organizationId", "expiresAt")',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE organization_invitation_request')
  }
}
