import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddTunnelTable1790294400000 implements MigrationInterface {
  name = 'AddTunnelTable1790294400000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "tunnel" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "box_id" character varying(12) NOT NULL,
        "port" integer NOT NULL,
        "access_mode" character varying NOT NULL,
        "token_hash" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "tunnel_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "tunnel_box_port_unique" UNIQUE ("box_id", "port"),
        CONSTRAINT "tunnel_port_range" CHECK ("port" BETWEEN 1 AND 65535),
        CONSTRAINT "tunnel_mode_token" CHECK (("access_mode" = 'public' AND "token_hash" IS NULL) OR ("access_mode" = 'private' AND "token_hash" IS NOT NULL)),
        CONSTRAINT "tunnel_box_fk" FOREIGN KEY ("box_id") REFERENCES "box"("id") ON DELETE CASCADE
      )
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tunnel"`)
  }
}
