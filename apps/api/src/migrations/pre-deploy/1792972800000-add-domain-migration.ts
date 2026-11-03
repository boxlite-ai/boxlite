import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddDomain1792972800000 implements MigrationInterface {
  name = 'AddDomain1792972800000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing organizations get the same initial allowance as a new one.
    await queryRunner.query(`ALTER TABLE "organization" ADD "domain_count_limit" integer NOT NULL DEFAULT 1`)
    // organization_id carries no foreign key, like box.organization_id: a name
    // outlives every box it was bound to, and the organization row is read
    // under a lock by the service that counts names against the limit.
    //
    // A Box target is the port itself, not its tunnel: a name may be bound
    // before the port is declared public, and several names may share a port.
    // Target references have no foreign keys: Box cleanup must retain the
    // binding until explicit unbind or rebind. The API validates live Box
    // targets when binding and checks access when routing. App targets use
    // app_id; the API refuses App binding until that resource exists.
    await queryRunner.query(`
      CREATE TABLE "domain" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "hostname" character varying(253) NOT NULL,
        "kind" character varying NOT NULL,
        "organization_id" uuid NOT NULL,
        "target_type" character varying NOT NULL DEFAULT 'box',
        "app_id" character varying(255),
        "box_id" character varying(12),
        "port" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "domain_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "domain_hostname_unique" UNIQUE ("hostname"),
        CONSTRAINT "domain_kind" CHECK ("kind" IN ('platform', 'custom')),
        CONSTRAINT "domain_target" CHECK (
          ("target_type" = 'box' AND "app_id" IS NULL
            AND ("box_id" IS NULL OR "port" IS NOT NULL)
            AND ("port" IS NULL OR "port" BETWEEN 1 AND 65535))
          OR ("target_type" = 'app' AND "box_id" IS NULL AND "port" IS NULL
            AND ("app_id" IS NULL OR "app_id" ~ '[^[:space:]]'))
        )
      )
    `)
    await queryRunner.query(`CREATE INDEX "domain_organization_id_index" ON "domain" ("organization_id")`)
    await queryRunner.query(`CREATE INDEX "domain_target_index" ON "domain" ("box_id", "port")`)
    await queryRunner.query(`CREATE INDEX "domain_app_target_index" ON "domain" ("app_id")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "domain"`)
    await queryRunner.query(`ALTER TABLE "organization" DROP COLUMN "domain_count_limit"`)
  }
}
