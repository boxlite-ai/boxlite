import type { QueryRunner } from 'typeorm'

export async function assertCompleteOutboundDrained(runner: QueryRunner, checkGeneration: boolean): Promise<void> {
  await runner.query('LOCK TABLE "runner", complete_outbound_runner_enrollment, "box", "job" IN ACCESS EXCLUSIVE MODE')
  const [state] = await runner.query(`SELECT
    EXISTS (SELECT 1 FROM "box" WHERE "completeOutboundControl" IS NOT NULL
      ${checkGeneration ? 'OR "completeOutboundGeneration" <> 0' : ''}) AS protected,
    EXISTS (SELECT 1 FROM "job" WHERE type = 'CREATE_COMPLETE_OUTBOUND_BOX' AND "completedAt" IS NULL) AS pending,
    EXISTS (SELECT 1 FROM complete_outbound_runner_enrollment WHERE expires_at > clock_timestamp()) AS enrolled`)
  if (state.protected || state.pending || state.enrolled) {
    throw new Error('Complete outbound policy, work, or enrollment still blocks downgrade')
  }
}
