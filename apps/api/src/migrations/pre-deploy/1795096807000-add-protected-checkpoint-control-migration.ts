import { MigrationInterface, QueryRunner } from 'typeorm'

const PROTECTED_TYPES = "'EXPORT_PROTECTED_CHECKPOINT', 'UPLOAD_PROTECTED_CHECKPOINT', 'IMPORT_PROTECTED_CHECKPOINT'"

export class AddProtectedCheckpointControl1795096807000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE "checkpoint" ADD COLUMN "captureOutbound" jsonb;
      ALTER TABLE "job" ADD COLUMN "checkpointCleanupRequired" boolean NOT NULL DEFAULT false;
      ALTER TABLE "checkpoint_operation" ADD COLUMN "protectedDisposalConfirmed" boolean NOT NULL DEFAULT false;
      ALTER TABLE complete_outbound_runner_enrollment
        ADD COLUMN protected_checkpoint_identity jsonb,
        ADD COLUMN protected_checkpoint_retirement jsonb;

      CREATE FUNCTION protect_checkpoint_job_transition() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'DELETE' AND OLD."completedAt" IS NOT NULL AND NOT OLD."checkpointCleanupRequired"
        THEN RETURN OLD; END IF;
        IF current_setting('boxlite.protected_checkpoint_transition', true) IS DISTINCT FROM 'on'
          OR NOT EXISTS (SELECT 1 FROM complete_outbound_admission WHERE id = 1 AND api_principal = current_user)
        THEN RETURN NULL; END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $body$;
      CREATE TRIGGER protect_checkpoint_job_transition BEFORE UPDATE OR DELETE ON "job"
        FOR EACH ROW WHEN (OLD.type IN (${PROTECTED_TYPES})) EXECUTE FUNCTION protect_checkpoint_job_transition();

      CREATE FUNCTION protect_checkpoint_release_floor() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.phase = 'downgrading' AND OLD.phase <> 'downgrading' AND
          (EXISTS (SELECT 1 FROM "checkpoint" WHERE "captureOutbound" IS NOT NULL)
           OR EXISTS (SELECT 1 FROM "job" WHERE type IN (${PROTECTED_TYPES})
             AND ("completedAt" IS NULL OR "checkpointCleanupRequired")))
        THEN RAISE EXCEPTION 'Protected checkpoint archives or work still block downgrade'; END IF;
        RETURN NEW;
      END
      $body$;
      CREATE TRIGGER protect_checkpoint_release_floor BEFORE UPDATE OF phase ON complete_outbound_admission
        FOR EACH ROW EXECUTE FUNCTION protect_checkpoint_release_floor();

      CREATE FUNCTION protect_checkpoint_owned_lease() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.lease_id = OLD.lease_id
          AND NEW.verified_floor = OLD.verified_floor AND NEW.token_sha256 = OLD.token_sha256
          AND NEW.runner_key_sha256 = OLD.runner_key_sha256
          AND NEW.protected_checkpoint_identity IS NOT DISTINCT FROM OLD.protected_checkpoint_identity
        THEN
          IF NEW.expires_at < OLD.expires_at
            OR NEW.protected_checkpoint_retirement IS DISTINCT FROM OLD.protected_checkpoint_retirement
          THEN PERFORM id FROM complete_outbound_admission WHERE id = 1 FOR UPDATE; END IF;
          RETURN NEW;
        END IF;
        PERFORM id FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
        IF EXISTS (SELECT 1 FROM "job" WHERE type IN (${PROTECTED_TYPES})
          AND "runnerId" = OLD.runner_id::text AND ("completedAt" IS NULL OR "checkpointCleanupRequired")
          AND CASE WHEN type IN (${PROTECTED_TYPES}) THEN CAST(payload AS jsonb) ->> 'lease_id' END = OLD.lease_id::text)
        THEN RAISE EXCEPTION 'Protected checkpoint work still owns the Runner lease'; END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $body$;
      CREATE TRIGGER protect_checkpoint_owned_lease BEFORE UPDATE OR DELETE ON complete_outbound_runner_enrollment
        FOR EACH ROW EXECUTE FUNCTION protect_checkpoint_owned_lease();
    `)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      LOCK TABLE complete_outbound_admission IN ACCESS EXCLUSIVE MODE;
      DO $body$ BEGIN
        IF EXISTS (SELECT 1 FROM "checkpoint" WHERE "captureOutbound" IS NOT NULL)
          OR EXISTS (SELECT 1 FROM "job" WHERE type IN (${PROTECTED_TYPES})
            AND ("completedAt" IS NULL OR "checkpointCleanupRequired"))
        THEN RAISE EXCEPTION 'Protected checkpoint archives and work must drain before downgrade'; END IF;
      END $body$;
      DROP TRIGGER protect_checkpoint_owned_lease ON complete_outbound_runner_enrollment;
      DROP FUNCTION protect_checkpoint_owned_lease();
      DROP TRIGGER protect_checkpoint_release_floor ON complete_outbound_admission;
      DROP FUNCTION protect_checkpoint_release_floor();
      DROP TRIGGER protect_checkpoint_job_transition ON "job";
      DROP FUNCTION protect_checkpoint_job_transition();
      ALTER TABLE complete_outbound_runner_enrollment
        DROP COLUMN protected_checkpoint_retirement, DROP COLUMN protected_checkpoint_identity;
      ALTER TABLE "job" DROP COLUMN "checkpointCleanupRequired";
      ALTER TABLE "checkpoint_operation" DROP COLUMN "protectedDisposalConfirmed";
      ALTER TABLE "checkpoint" DROP COLUMN "captureOutbound";
    `)
  }
}
