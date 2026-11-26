import { MigrationInterface, QueryRunner } from 'typeorm'
import { createLegacyCompleteOutboundActivation } from './1795096806000-add-complete-outbound-release-control-migration'

export class AddCompleteOutboundReleaseAttempts1795096810000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP FUNCTION complete_outbound_activate(text, name, name[], text);

      CREATE TABLE complete_outbound_release_attempt (
        id uuid PRIMARY KEY,
        stage text NOT NULL CHECK (stage ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
        release_floor text NOT NULL CHECK (length(trim(release_floor)) > 0),
        application name NOT NULL,
        acceptance_organization_id uuid,
        predecessor_receipt text,
        handed_off_from name,
        manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
        bootstrap_sha256 text CHECK (
          bootstrap_sha256 IS NULL OR (bootstrap_sha256 ~ '^[a-f0-9]{64}$' AND predecessor_receipt IS NULL)
        ),
        expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
        state text NOT NULL DEFAULT 'pending' CHECK (
          state IN ('pending', 'provisional', 'accepted', 'aborted', 'expired')
        ),
        evidence_sha256 text CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
        CHECK ((state = 'accepted') = (evidence_sha256 IS NOT NULL)),
        CHECK ((stage = 'dev') = (acceptance_organization_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX complete_outbound_one_unfinished_release
        ON complete_outbound_release_attempt ((true)) WHERE state IN ('pending', 'provisional');
      CREATE UNIQUE INDEX complete_outbound_one_use_evidence
        ON complete_outbound_release_attempt (evidence_sha256) WHERE evidence_sha256 IS NOT NULL;
      REVOKE ALL ON complete_outbound_release_attempt FROM PUBLIC;

      CREATE FUNCTION complete_outbound_grant_serving_role(principal name)
      RETURNS void LANGUAGE plpgsql AS $body$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = principal AND r.rolcanlogin
          AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT pg_has_role(r.oid,
            (SELECT relowner FROM pg_class WHERE oid = 'complete_outbound_admission'::regclass), 'MEMBER'))
          OR has_table_privilege(principal, 'complete_outbound_admission', 'UPDATE, INSERT, DELETE, TRUNCATE')
          OR has_table_privilege(principal, 'complete_outbound_runner_enrollment', 'UPDATE, INSERT, DELETE, TRUNCATE')
        THEN RAISE EXCEPTION 'Complete outbound requires a dedicated non-owner application principal'; END IF;
        EXECUTE format('GRANT SELECT, UPDATE (id) ON complete_outbound_admission TO %I', principal);
        EXECUTE format('GRANT SELECT ON complete_outbound_runner_enrollment TO %I', principal);
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_grant_serving_role(name) FROM PUBLIC;

      CREATE FUNCTION complete_outbound_require_live_cohort(release text)
      RETURNS void LANGUAGE plpgsql AS $body$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM "runner" WHERE state = 'ready') OR EXISTS (
          SELECT 1 FROM "runner" r LEFT JOIN complete_outbound_runner_enrollment e ON e.runner_id = r.id
          WHERE r.state <> 'decommissioned' AND (
            r."apiVersion" NOT IN ('0', '2') OR e.runner_id IS NULL OR e.verified_floor <> release OR
            e.runner_key_sha256 <> encode(sha256(convert_to(r."apiKey", 'UTF8')), 'hex') OR
            e.expires_at <= clock_timestamp()
          )
        ) THEN RAISE EXCEPTION 'The Runner cohort is incomplete or incompatible'; END IF;
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_require_live_cohort(text) FROM PUBLIC;

      CREATE FUNCTION complete_outbound_rehearsal_has_checkpoint_work()
      RETURNS boolean LANGUAGE sql STABLE AS $body$
        SELECT EXISTS (
          SELECT 1 FROM "job"
          WHERE type IN ('EXPORT_PROTECTED_CHECKPOINT', 'UPLOAD_PROTECTED_CHECKPOINT', 'IMPORT_PROTECTED_CHECKPOINT')
            AND ("completedAt" IS NULL OR "checkpointCleanupRequired")
        );
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_rehearsal_has_checkpoint_work() FROM PUBLIC;

      CREATE FUNCTION complete_outbound_begin_attempt(
        attempt_id uuid, stage_name text, release text, principal name, organization_id uuid,
        expected_receipt text, manifest text, deadline timestamptz, bootstrap text DEFAULT NULL
      ) RETURNS void LANGUAGE plpgsql AS $body$
      DECLARE control complete_outbound_admission%ROWTYPE;
      BEGIN
        IF (stage_name = 'dev') <> (organization_id IS NOT NULL)
        THEN RAISE EXCEPTION 'Acceptance organizations are only available in dev and required there'; END IF;
        SELECT * INTO STRICT control FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
        IF control.phase <> 'closed' OR control.deployment_receipt IS DISTINCT FROM expected_receipt
          OR deadline <= clock_timestamp() OR (bootstrap IS NOT NULL
            AND (control.minimum_release IS NOT NULL OR control.api_principal IS NOT NULL OR expected_receipt IS NOT NULL))
        THEN RAISE EXCEPTION 'Release attempt is no longer eligible'; END IF;
        IF stage_name = 'dev' AND complete_outbound_rehearsal_has_checkpoint_work()
        THEN RAISE EXCEPTION 'Previous rehearsal still owns protected checkpoint work'; END IF;
        INSERT INTO complete_outbound_release_attempt
          (id, stage, release_floor, application, acceptance_organization_id, predecessor_receipt,
           manifest_sha256, expires_at, bootstrap_sha256)
        VALUES (attempt_id, stage_name, release, principal, organization_id, expected_receipt, manifest, deadline, bootstrap);
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_begin_attempt(uuid, text, text, name, uuid, text, text, timestamptz, text)
        FROM PUBLIC;

      CREATE FUNCTION complete_outbound_handoff_attempt(attempt_id uuid, predecessor name)
      RETURNS void LANGUAGE plpgsql AS $body$
      DECLARE control complete_outbound_admission%ROWTYPE;
      DECLARE attempt complete_outbound_release_attempt%ROWTYPE;
      BEGIN
        SELECT * INTO STRICT control FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
        SELECT * INTO STRICT attempt FROM complete_outbound_release_attempt WHERE id = attempt_id FOR UPDATE;
        IF control.phase <> 'closed' OR control.deployment_receipt IS DISTINCT FROM attempt.predecessor_receipt
          OR control.minimum_release IS NULL OR control.api_principal IS DISTINCT FROM predecessor
          OR predecessor IS NULL OR predecessor = attempt.application OR predecessor = current_user
          OR attempt.state <> 'pending' OR attempt.expires_at <= clock_timestamp()
        THEN RAISE EXCEPTION 'Release attempt is no longer eligible'; END IF;
        PERFORM complete_outbound_grant_serving_role(attempt.application);
        EXECUTE format('ALTER ROLE %I NOLOGIN', predecessor);
        UPDATE complete_outbound_admission SET api_principal = attempt.application WHERE id = 1;
        UPDATE complete_outbound_release_attempt SET handed_off_from = predecessor WHERE id = attempt_id;
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_handoff_attempt(uuid, name) FROM PUBLIC;

      CREATE FUNCTION complete_outbound_activate_attempt(
        attempt_id uuid, retired name[], cohort jsonb DEFAULT NULL, manifest text DEFAULT NULL, evidence text DEFAULT NULL
      )
      RETURNS void LANGUAGE plpgsql AS $body$
      DECLARE control complete_outbound_admission%ROWTYPE;
      DECLARE attempt complete_outbound_release_attempt%ROWTYPE;
      DECLARE staged_count integer;
      BEGIN
        SELECT * INTO STRICT control FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
        SELECT * INTO STRICT attempt FROM complete_outbound_release_attempt WHERE id = attempt_id FOR UPDATE;
        IF (attempt.stage = 'dev' AND (manifest IS NOT NULL OR evidence IS NOT NULL))
          OR (attempt.stage <> 'dev' AND (manifest IS DISTINCT FROM attempt.manifest_sha256
            OR evidence IS NULL OR evidence !~ '^[a-f0-9]{64}$'))
        THEN RAISE EXCEPTION 'Release evidence must match the target attempt'; END IF;
        IF attempt.state = 'accepted' AND control.phase = 'open' AND control.deployment_receipt = attempt_id::text
          AND attempt.evidence_sha256 = evidence THEN RETURN; END IF;
        IF control.phase <> 'closed' OR control.deployment_receipt IS DISTINCT FROM attempt.predecessor_receipt
          OR (control.minimum_release IS NOT NULL AND control.api_principal IS DISTINCT FROM attempt.application)
          OR attempt.state <> 'pending' OR attempt.expires_at <= clock_timestamp()
        THEN RAISE EXCEPTION 'Release attempt is no longer eligible'; END IF;
        IF attempt.handed_off_from IS NOT NULL AND NOT COALESCE(attempt.handed_off_from = ANY(retired), false)
        THEN RAISE EXCEPTION 'The retired principal does not match the release handoff'; END IF;
        IF EXISTS (SELECT 1 FROM unnest(retired) AS retired_role(principal)
          LEFT JOIN pg_roles role ON role.rolname = retired_role.principal WHERE role.oid IS NULL)
        THEN RAISE EXCEPTION 'A retired principal could not be verified'; END IF;
        IF COALESCE(cardinality(retired), 0) = 0 AND (attempt.bootstrap_sha256 IS NULL
          OR control.minimum_release IS NOT NULL OR control.api_principal IS NOT NULL
          OR control.deployment_receipt IS NOT NULL)
        THEN RAISE EXCEPTION 'Release attempt has no verified initial rollout'; END IF;
        IF attempt.application = ANY(retired)
          OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = ANY(retired) AND r.rolcanlogin)
          OR EXISTS (SELECT 1 FROM pg_stat_activity p WHERE p.usename = ANY(retired))
        THEN RAISE EXCEPTION 'An old application principal can still connect or has an active session'; END IF;
        PERFORM complete_outbound_grant_serving_role(attempt.application);
        IF cohort IS NOT NULL THEN
          WITH staged AS (
            SELECT * FROM jsonb_to_recordset(cohort) AS item(
              runner_id uuid, lease_id uuid, token_sha256 text, runner_key_sha256 text,
              expires_at timestamptz, protected_checkpoint_identity jsonb
            )
          ), applied AS (
            INSERT INTO complete_outbound_runner_enrollment
              (runner_id, lease_id, token_sha256, verified_floor, runner_key_sha256, expires_at,
               protected_checkpoint_identity)
            SELECT staged.runner_id, staged.lease_id, staged.token_sha256, attempt.release_floor,
              staged.runner_key_sha256, staged.expires_at, staged.protected_checkpoint_identity
            FROM staged JOIN "runner" r ON r.id = staged.runner_id
            WHERE r.state <> 'decommissioned' AND r."apiVersion" = '2'
              AND jsonb_typeof(staged.protected_checkpoint_identity) = 'object'
              AND staged.expires_at > clock_timestamp() AND isfinite(staged.expires_at)
            ON CONFLICT (runner_id) DO UPDATE SET lease_id = EXCLUDED.lease_id, token_sha256 = EXCLUDED.token_sha256,
              verified_floor = EXCLUDED.verified_floor, runner_key_sha256 = EXCLUDED.runner_key_sha256,
              expires_at = EXCLUDED.expires_at, protected_checkpoint_identity = EXCLUDED.protected_checkpoint_identity,
              protected_checkpoint_retirement = NULL
            RETURNING runner_id
          )
          SELECT count(*) FROM applied INTO staged_count;
          IF staged_count = 0 OR staged_count <> jsonb_array_length(cohort)
            OR staged_count <> (SELECT count(*) FROM "runner" WHERE state <> 'decommissioned')
          THEN RAISE EXCEPTION 'The staged Runner cohort is incomplete or incompatible'; END IF;
        END IF;
        PERFORM complete_outbound_require_live_cohort(attempt.release_floor);
        IF attempt.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Release attempt is no longer eligible'; END IF;
        UPDATE complete_outbound_admission SET phase = 'open', minimum_release = attempt.release_floor,
          api_principal = attempt.application, deployment_receipt = attempt_id::text,
          acceptance_organization_id = attempt.acceptance_organization_id,
          acceptance_expires_at = CASE WHEN attempt.stage = 'dev' THEN attempt.expires_at END
          WHERE id = 1;
        UPDATE complete_outbound_release_attempt SET
          state = CASE WHEN attempt.stage = 'dev' THEN 'provisional' ELSE 'accepted' END,
          evidence_sha256 = evidence WHERE id = attempt_id;
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_activate_attempt(uuid, name[], jsonb, text, text) FROM PUBLIC;

      CREATE FUNCTION complete_outbound_close_target_attempt(attempt_id uuid, evidence text)
      RETURNS boolean LANGUAGE plpgsql AS $body$
      BEGIN
        PERFORM id FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
        UPDATE complete_outbound_admission SET phase = 'closed'
          WHERE id = 1 AND phase = 'open' AND deployment_receipt = attempt_id::text
            AND EXISTS (SELECT 1 FROM complete_outbound_release_attempt
              WHERE id = attempt_id AND stage <> 'dev' AND state = 'accepted' AND evidence_sha256 = evidence);
        RETURN FOUND;
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_close_target_attempt(uuid, text) FROM PUBLIC;

      CREATE FUNCTION complete_outbound_end_attempt(attempt_id uuid, expired_only boolean)
      RETURNS boolean LANGUAGE plpgsql AS $body$
      DECLARE attempt complete_outbound_release_attempt%ROWTYPE;
      BEGIN
        PERFORM id FROM complete_outbound_admission WHERE id = 1 FOR UPDATE;
        SELECT * INTO attempt FROM complete_outbound_release_attempt WHERE id = attempt_id FOR UPDATE;
        IF NOT FOUND OR attempt.state NOT IN ('pending', 'provisional')
          OR (expired_only AND attempt.expires_at > clock_timestamp()) THEN RETURN false; END IF;
        IF attempt.state = 'provisional' THEN
          UPDATE complete_outbound_admission SET phase = 'closed',
            acceptance_organization_id = NULL, acceptance_expires_at = NULL
            WHERE id = 1 AND phase = 'open' AND deployment_receipt = attempt_id::text;
        END IF;
        UPDATE complete_outbound_release_attempt SET state = CASE WHEN expired_only THEN 'expired' ELSE 'aborted' END
          WHERE id = attempt_id;
        RETURN true;
      END
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_end_attempt(uuid, boolean) FROM PUBLIC;

      CREATE FUNCTION complete_outbound_expire_attempt(attempt_id uuid)
      RETURNS boolean LANGUAGE sql AS $body$
        SELECT complete_outbound_end_attempt(attempt_id, true)
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_expire_attempt(uuid) FROM PUBLIC;

      CREATE FUNCTION complete_outbound_reconcile_attempts(stage_name text)
      RETURNS TABLE (attempt_id uuid) LANGUAGE sql AS $body$
        WITH expired AS MATERIALIZED (
          SELECT id FROM complete_outbound_release_attempt
          WHERE stage = stage_name AND state IN ('pending', 'provisional') AND expires_at <= clock_timestamp()
        )
        SELECT id FROM expired WHERE complete_outbound_expire_attempt(id)
      $body$;
      REVOKE ALL ON FUNCTION complete_outbound_reconcile_attempts(text) FROM PUBLIC;
    `)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('LOCK TABLE complete_outbound_admission IN ACCESS EXCLUSIVE MODE')
    const [control] = await runner.query('SELECT phase, minimum_release FROM complete_outbound_admission WHERE id = 1')
    if (
      !control ||
      (control.phase !== 'downgrading' && (control.phase !== 'closed' || control.minimum_release !== null))
    ) {
      throw new Error('Drain complete outbound before restoring the legacy activation entry')
    }
    const [attempt] = await runner.query(
      "SELECT id FROM complete_outbound_release_attempt WHERE state IN ('pending', 'provisional')",
    )
    if (attempt) throw new Error('Reconcile active complete outbound release attempts before reverting the migration')
    await runner.query(`
      DROP FUNCTION complete_outbound_reconcile_attempts(text);
      DROP FUNCTION complete_outbound_expire_attempt(uuid);
      DROP FUNCTION complete_outbound_end_attempt(uuid, boolean);
      DROP FUNCTION complete_outbound_close_target_attempt(uuid, text);
      DROP FUNCTION complete_outbound_activate_attempt(uuid, name[], jsonb, text, text);
      DROP FUNCTION complete_outbound_handoff_attempt(uuid, name);
      DROP FUNCTION complete_outbound_begin_attempt(uuid, text, text, name, uuid, text, text, timestamptz, text);
      DROP FUNCTION complete_outbound_rehearsal_has_checkpoint_work();
      DROP FUNCTION complete_outbound_require_live_cohort(text);
      DROP FUNCTION complete_outbound_grant_serving_role(name);
      DROP TABLE complete_outbound_release_attempt;
      ${createLegacyCompleteOutboundActivation}
    `)
  }
}
