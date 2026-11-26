import { MigrationInterface, QueryRunner } from 'typeorm'

export const createLegacyCompleteOutboundActivation = `
      CREATE FUNCTION complete_outbound_activate(release_floor text, application name, retired name[], receipt text)
      RETURNS void LANGUAGE plpgsql AS $body$
      DECLARE control complete_outbound_admission%ROWTYPE;
      BEGIN
        SELECT * INTO STRICT control FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
        IF control.phase <> 'closed' OR nullif(trim(release_floor), '') IS NULL OR
            nullif(trim(receipt), '') IS NULL OR COALESCE(cardinality(retired), 0) = 0 OR application = ANY(retired)
        THEN RAISE EXCEPTION 'Complete outbound release has no verified rollout'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = application AND r.rolcanlogin
          AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT pg_has_role(r.oid,
            (SELECT relowner FROM pg_class WHERE oid = 'complete_outbound_admission'::regclass), 'MEMBER'))
          OR has_table_privilege(application, 'complete_outbound_admission', 'UPDATE, INSERT, DELETE, TRUNCATE')
        THEN RAISE EXCEPTION 'Complete outbound requires a dedicated non-owner application principal'; END IF;
        IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = ANY(retired) AND r.rolcanlogin) OR
          EXISTS (SELECT 1 FROM pg_stat_activity p WHERE p.usename = ANY(retired))
        THEN RAISE EXCEPTION 'An old application principal can still connect or has an active session'; END IF;
        IF NOT EXISTS (SELECT 1 FROM "runner" WHERE state = 'ready') OR EXISTS (
          SELECT 1 FROM "runner" r LEFT JOIN complete_outbound_runner_enrollment e ON e.runner_id = r.id
          WHERE r.state <> 'decommissioned' AND (
            r."apiVersion" NOT IN ('0', '2') OR e.runner_id IS NULL OR e.verified_floor <> release_floor OR
            e.runner_key_sha256 <> encode(sha256(convert_to(r."apiKey", 'UTF8')), 'hex') OR
            e.expires_at <= clock_timestamp()
          )
        ) THEN RAISE EXCEPTION 'The Runner cohort is incomplete or incompatible'; END IF;
        EXECUTE format('GRANT SELECT, UPDATE (id) ON complete_outbound_admission TO %I', application);
        EXECUTE format('GRANT SELECT ON complete_outbound_runner_enrollment TO %I', application);
        UPDATE complete_outbound_admission SET phase = 'open', minimum_release = release_floor,
          api_principal = application, deployment_receipt = receipt WHERE id = 1;
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_activate(text, name, name[], text) FROM PUBLIC;
`

export class AddCompleteOutboundReleaseControl1795096806000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ${createLegacyCompleteOutboundActivation}
      CREATE FUNCTION complete_outbound_close()
      RETURNS void LANGUAGE plpgsql AS $body$
      BEGIN
        UPDATE complete_outbound_admission SET phase = 'closed' WHERE id = 1 AND phase = 'open';
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_close() FROM PUBLIC;

      CREATE FUNCTION complete_outbound_begin_downgrade()
      RETURNS void LANGUAGE plpgsql AS $body$
      BEGIN
        PERFORM id FROM complete_outbound_admission WHERE id = 1 AND phase = 'closed' FOR UPDATE;
        IF NOT FOUND OR EXISTS (SELECT 1 FROM "box" WHERE "completeOutboundControl" IS NOT NULL OR "completeOutboundGeneration" <> 0)
          OR EXISTS (SELECT 1 FROM "job" WHERE type = 'CREATE_COMPLETE_OUTBOUND_BOX' AND "completedAt" IS NULL)
          OR EXISTS (SELECT 1 FROM complete_outbound_runner_enrollment WHERE expires_at > clock_timestamp())
        THEN RAISE EXCEPTION 'Complete outbound policy, work, or enrollment still blocks downgrade'; END IF;
        UPDATE complete_outbound_admission SET phase = 'downgrading' WHERE id = 1;
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_begin_downgrade() FROM PUBLIC;

      CREATE FUNCTION complete_outbound_protect_owned_lease()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.lease_id = OLD.lease_id
          AND NEW.verified_floor = OLD.verified_floor AND NEW.token_sha256 = OLD.token_sha256
          AND NEW.runner_key_sha256 = OLD.runner_key_sha256 THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND NEW.lease_id = OLD.lease_id
        THEN RAISE EXCEPTION 'Credential rotation requires a new complete outbound lease'; END IF;
        PERFORM id FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
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
    await runner.query('LOCK TABLE complete_outbound_admission IN ACCESS EXCLUSIVE MODE')
    const [control] = await runner.query('SELECT phase, minimum_release FROM complete_outbound_admission WHERE id = 1')
    if (
      !control ||
      (control.phase !== 'downgrading' && (control.phase !== 'closed' || control.minimum_release !== null))
    ) {
      throw new Error('Complete outbound release must drain before removing its control procedures')
    }
    await runner.query('DROP FUNCTION complete_outbound_activate(text, name, name[], text)')
    await runner.query('DROP FUNCTION complete_outbound_close()')
    await runner.query('DROP FUNCTION complete_outbound_begin_downgrade()')
    await runner.query('DROP TRIGGER complete_outbound_protect_owned_lease ON complete_outbound_runner_enrollment')
    await runner.query('DROP FUNCTION complete_outbound_protect_owned_lease()')
  }
}
