import { MigrationInterface, QueryRunner } from 'typeorm'

export class RetireUnusedJobTypes1786300000000 implements MigrationInterface {
  name = 'RetireUnusedJobTypes1786300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // RESIZE_BOX used the normal state-change lock and completion handler. Match
    // that handler's state restoration before removing the job from polling;
    // unexpected desired states become explicit errors instead of remaining
    // stuck in RESIZING. The Redis lock has a 30-second TTL and is not renewed
    // by a database migration, so it expires independently after this cleanup.
    await queryRunner.query(
      `UPDATE "box" SET "state" = CASE "desiredState" WHEN 'started' THEN 'started'::"public"."box_state_enum" WHEN 'stopped' THEN 'stopped'::"public"."box_state_enum" ELSE 'error'::"public"."box_state_enum" END, "pending" = false, "errorReason" = CASE WHEN "desiredState" IN ('started', 'stopped') THEN "errorReason" ELSE 'Legacy resize job had an invalid desired state' END, "updatedAt" = NOW() WHERE "state" = 'resizing' AND EXISTS (SELECT 1 FROM "job" WHERE "job"."resourceId" = "box"."id" AND "job"."type" = 'RESIZE_BOX' AND "job"."completedAt" IS NULL)`,
    )
    await queryRunner.query(
      `UPDATE "job" SET "status" = 'FAILED', "completedAt" = NOW(), "updatedAt" = NOW(), "errorMessage" = 'Job type is no longer supported' WHERE "completedAt" IS NULL AND "type" IN ('RESIZE_BOX', 'CREATE_BACKUP', 'PULL_ARTIFACT', 'RECOVER_BOX', 'INSPECT_ARTIFACT_IN_REGISTRY', 'REMOVE_ARTIFACT', 'UPDATE_BOX_NETWORK_SETTINGS')`,
    )
  }

  public down(): Promise<void> {
    // The previous in-flight state cannot be reconstructed safely.
    return Promise.resolve()
  }
}
