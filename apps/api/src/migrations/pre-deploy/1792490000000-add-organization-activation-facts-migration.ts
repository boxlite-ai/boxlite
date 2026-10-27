import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationActivationFacts1792490000000 implements MigrationInterface {
  name = 'AddOrganizationActivationFacts1792490000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Activation migration requires a transaction')
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`)
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`)
    await queryRunner.query(`
      CREATE TABLE organization_activation_facts (
        "organizationId" uuid PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
        "lastBoxCreatedAt" timestamptz,
        "lastBoxModifiedAt" timestamptz
      )
    `)
    // Existing organizations predate tracking: only the newest retained Box
    // creation is recoverable. Organizations without one start without a row.
    await queryRunner.query(`
      INSERT INTO organization_activation_facts ("organizationId", "lastBoxCreatedAt")
      SELECT organization.id, max(box."createdAt")
      FROM organization JOIN box ON box."organizationId" = organization.id
      WHERE organization.id <> '00000000-0000-0000-0000-000000000000'::uuid
      GROUP BY organization.id
    `)
    await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`)
    await queryRunner.query(`SET LOCAL statement_timeout = DEFAULT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE organization_activation_facts`)
  }
}
