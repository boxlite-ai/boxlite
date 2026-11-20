import { MigrationInterface, QueryRunner } from 'typeorm'

export class ExtendOutboundProxyRuntimeState1795153000000 implements MigrationInterface {
  name = 'ExtendOutboundProxyRuntimeState1795153000000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE outbound_proxy_reference
        DROP CONSTRAINT outbound_proxy_reference_kind_check,
        ALTER COLUMN runtime_epoch DROP NOT NULL,
        ADD COLUMN purpose text NOT NULL DEFAULT 'legacy',
        ADD CONSTRAINT outbound_proxy_reference_kind_check
          CHECK (kind IN ('committed', 'pending', 'retained')),
        ADD CONSTRAINT outbound_proxy_reference_purpose_check
          CHECK (purpose IN ('legacy', 'bootstrap', 'update')),
        ADD CONSTRAINT outbound_proxy_reference_epoch_check
          CHECK (
            (runtime_epoch IS NOT NULL AND length(runtime_epoch) > 0)
            OR (runtime_epoch IS NULL AND kind = 'pending' AND purpose = 'bootstrap')
          );

      ALTER TABLE outbound_proxy_registration
        ADD COLUMN rollout_check_after timestamptz NOT NULL DEFAULT '-infinity';
      CREATE INDEX outbound_proxy_rollout_due_idx
        ON outbound_proxy_registration (rollout_check_after, organization_id, id)
        WHERE rollout_pending;

      ALTER TABLE "box" ADD "outboundControlDueAt" timestamptz;
      CREATE INDEX box_outbound_control_due_idx
        ON "box" ("outboundControlDueAt", id)
        WHERE "outboundControlDueAt" IS NOT NULL;
    `)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE outbound_proxy_reference
        ALTER COLUMN runtime_epoch SET NOT NULL,
        DROP CONSTRAINT outbound_proxy_reference_epoch_check,
        DROP CONSTRAINT outbound_proxy_reference_purpose_check,
        DROP CONSTRAINT outbound_proxy_reference_kind_check,
        DROP COLUMN purpose,
        ADD CONSTRAINT outbound_proxy_reference_kind_check
          CHECK (kind IN ('committed', 'pending'));

      DROP INDEX outbound_proxy_rollout_due_idx;
      ALTER TABLE outbound_proxy_registration DROP COLUMN rollout_check_after;

      DROP INDEX box_outbound_control_due_idx;
      ALTER TABLE "box" DROP COLUMN "outboundControlDueAt";
    `)
  }
}
