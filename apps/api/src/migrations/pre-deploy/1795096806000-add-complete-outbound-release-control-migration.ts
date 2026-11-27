import { MigrationInterface, QueryRunner } from 'typeorm'
import { assertCompleteOutboundDrained } from '../complete-outbound-schema'

export class AddCompleteOutboundReleaseControl1795096806000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE FUNCTION complete_outbound_protect_owned_lease()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.lease_id = OLD.lease_id
          AND NEW.verified_floor = OLD.verified_floor AND NEW.token_sha256 = OLD.token_sha256
          AND NEW.runner_key_sha256 = OLD.runner_key_sha256 THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND NEW.lease_id = OLD.lease_id
        THEN RAISE EXCEPTION 'Credential rotation requires a new complete outbound lease'; END IF;
        IF EXISTS (SELECT 1 FROM "job" WHERE type = 'CREATE_COMPLETE_OUTBOUND_BOX'
          AND "runnerId" = CAST(OLD.runner_id AS text) AND status = 'IN_PROGRESS' AND "completedAt" IS NULL
          AND CASE WHEN type = 'CREATE_COMPLETE_OUTBOUND_BOX' THEN CAST(payload AS jsonb) ->> 'lease_id' END = CAST(OLD.lease_id AS text))
          OR EXISTS (SELECT 1 FROM "box" WHERE "runnerId" = OLD.runner_id AND
            ("completeOutboundControl" #>> '{pending,runnerLeaseId}' = CAST(OLD.lease_id AS text) OR
             "completeOutboundControl" #>> '{finalization,runnerLeaseId}' = CAST(OLD.lease_id AS text)))
        THEN RAISE EXCEPTION 'Complete outbound work still owns the Runner lease'; END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $body$;
      CREATE TRIGGER complete_outbound_protect_owned_lease
        BEFORE UPDATE OR DELETE ON complete_outbound_runner_enrollment
        FOR EACH ROW EXECUTE FUNCTION complete_outbound_protect_owned_lease();
    `)
  }

  async down(runner: QueryRunner): Promise<void> {
    await assertCompleteOutboundDrained(runner, true)
    await runner.query('DROP TRIGGER complete_outbound_protect_owned_lease ON complete_outbound_runner_enrollment')
    await runner.query('DROP FUNCTION complete_outbound_protect_owned_lease()')
  }
}
