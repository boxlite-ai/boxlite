import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddPendingAuditIndex1794196800000 implements MigrationInterface {
  transaction = false

  async up(runner: QueryRunner): Promise<void> {
    const [existing] = await runner.query(`SELECT i.indisvalid, i.indisunique, i.indnatts,
      i.indrelid = 'audit_log'::regclass AS expected_table,
      pg_get_indexdef(i.indexrelid, 1, true) AS key,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i WHERE i.indexrelid = to_regclass('idx_audit_log_pending_created_at')`)
    if (existing) {
      if (
        !existing.expected_table ||
        existing.indisunique ||
        existing.indnatts !== 1 ||
        existing.key !== '"createdAt"' ||
        existing.predicate !== '("statusCode" IS NULL)'
      ) {
        throw new Error('idx_audit_log_pending_created_at exists with an unexpected definition')
      }
      if (existing.indisvalid) return
      // Interrupted concurrent builds leave an invalid index; IF NOT EXISTS alone cannot repair it.
      await runner.query('DROP INDEX CONCURRENTLY idx_audit_log_pending_created_at')
    }
    await runner.query(`CREATE INDEX CONCURRENTLY idx_audit_log_pending_created_at
      ON audit_log ("createdAt") WHERE "statusCode" IS NULL`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX CONCURRENTLY IF EXISTS idx_audit_log_pending_created_at')
  }
}
