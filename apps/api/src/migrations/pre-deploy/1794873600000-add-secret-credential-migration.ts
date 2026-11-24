import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddSecretCredential1794873600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE secret_credential (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash bytea NOT NULL UNIQUE,
      runner_id varchar(64) NOT NULL,
      box_id varchar(64) NOT NULL REFERENCES box(id) ON DELETE CASCADE,
      organization_id uuid NOT NULL,
      grants jsonb NOT NULL,
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      CHECK (expires_at > issued_at)
    )`)
    await queryRunner.query('CREATE INDEX secret_credential_box_idx ON secret_credential(box_id)')
    await queryRunner.query('CREATE INDEX secret_credential_expires_idx ON secret_credential(expires_at)')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE secret_credential')
  }
}
