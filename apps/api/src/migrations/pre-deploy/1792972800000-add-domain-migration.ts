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
    // The target is the box port itself, not its tunnel: a name may be bound
    // before the port is declared public, and several names may share a port.
    // box_id says whether the name is bound. Deleting the box clears box_id
    // alone — PostgreSQL's SET NULL reaches only foreign key columns — and a
    // port left beside a null box_id means nothing.
    await queryRunner.query(`
      CREATE TABLE "domain" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "hostname" character varying(253) NOT NULL,
        "kind" character varying NOT NULL,
        "organization_id" uuid NOT NULL,
        "box_id" character varying(12),
        "port" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "domain_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "domain_hostname_unique" UNIQUE ("hostname"),
        CONSTRAINT "domain_kind" CHECK ("kind" IN ('platform', 'custom')),
        CONSTRAINT "domain_target" CHECK (("box_id" IS NULL OR "port" IS NOT NULL) AND "port" BETWEEN 1 AND 65535),
        CONSTRAINT "domain_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "box"("id") ON DELETE SET NULL
      )
    `)
    await queryRunner.query(`CREATE INDEX "domain_organization_id_index" ON "domain" ("organization_id")`)
    await queryRunner.query(`CREATE INDEX "domain_target_index" ON "domain" ("box_id", "port")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "domain"`)
    await queryRunner.query(`ALTER TABLE "organization" DROP COLUMN "domain_count_limit"`)
  }
}
