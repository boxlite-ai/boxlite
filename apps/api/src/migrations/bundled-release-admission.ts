// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import { baseDataSourceOptions } from './data-source'
import { MigrationDataSource } from './migration-data-source'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const role = z
  .string()
  .min(1)
  .max(63)
  .refine((value) => !value.includes('\0') && Buffer.byteLength(value) <= 63)
const attemptId = z.uuid()
const stage = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const instant = z.iso.datetime({ offset: true })
const writer = z.strictObject({
  provider: z.literal('gcp'),
  project: z.string().min(1),
  zone: z.string().min(1),
  instanceId: z.string().regex(/^\d+$/),
  workDiskIds: z.array(z.string().regex(/^\d+$/)).min(1),
})
const lease = z.strictObject({
  runner_id: z.uuid(),
  lease_id: z.uuid(),
  token_sha256: digest,
  runner_key_sha256: digest,
  expires_at: instant,
  protected_checkpoint_identity: writer,
})

const request = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('begin'),
    attemptId,
    stage,
    floor: z.string().min(1),
    application: role,
    organizationId: z.uuid().nullable(),
    predecessorReceipt: z.string().min(1).nullable(),
    manifestSha256: digest,
    expiresAt: instant,
    bootstrapSha256: digest.optional(),
  }),
  z.strictObject({ operation: z.literal('handoff'), attemptId, predecessor: role }),
  z.strictObject({
    operation: z.literal('activate'),
    attemptId,
    retired: z.array(role),
    cohort: z.array(lease).min(1),
  }),
  z.strictObject({
    operation: z.literal('activate-target'),
    attemptId,
    retired: z.array(role),
    cohort: z.array(lease).min(1),
    manifestSha256: digest,
    evidenceSha256: digest,
  }),
  z.strictObject({ operation: z.literal('close-target'), attemptId, evidenceSha256: digest }),
  z.strictObject({ operation: z.literal('abort'), attemptId }),
  z.strictObject({ operation: z.literal('expire'), attemptId }),
  z.strictObject({ operation: z.literal('reconcile'), stage }),
  z.strictObject({ operation: z.literal('status'), attemptId }),
])

export async function runBundledReleaseAdmission(input: string | undefined) {
  if (!input || Buffer.byteLength(input) > 1024 * 1024)
    throw new Error('Missing or oversized release admission request')
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    throw new Error('Invalid release admission JSON')
  }
  const parsed = request.safeParse(payload)
  if (!parsed.success) throw new Error('Invalid release admission request')
  const operation = parsed.data
  const source = new MigrationDataSource({
    ...baseDataSourceOptions,
    entities: [],
    migrations: [],
    logging: false,
    extra: { connectionTimeoutMillis: 5000, options: '-c lock_timeout=5000 -c statement_timeout=30000' },
  })
  await source.initialize()
  try {
    switch (operation.operation) {
      case 'begin':
        await source.query('SELECT complete_outbound_begin_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
          operation.attemptId,
          operation.stage,
          operation.floor,
          operation.application,
          operation.organizationId,
          operation.predecessorReceipt,
          operation.manifestSha256,
          operation.expiresAt,
          operation.bootstrapSha256 ?? null,
        ])
        return { state: 'pending' }
      case 'handoff':
        await source.query('SELECT complete_outbound_handoff_attempt($1, $2)', [
          operation.attemptId,
          operation.predecessor,
        ])
        return { transferred: true }
      case 'activate':
      case 'activate-target': {
        const target = operation.operation === 'activate-target'
        await source.query('SELECT complete_outbound_activate_attempt($1, $2, $3::jsonb, $4, $5)', [
          operation.attemptId,
          operation.retired,
          JSON.stringify(operation.cohort),
          target ? operation.manifestSha256 : null,
          target ? operation.evidenceSha256 : null,
        ])
        return { state: target ? 'accepted' : 'provisional' }
      }
      case 'close-target': {
        const [result] = await source.query('SELECT complete_outbound_close_target_attempt($1, $2) AS closed', [
          operation.attemptId,
          operation.evidenceSha256,
        ])
        return result
      }
      case 'abort': {
        const [result] = await source.query('SELECT complete_outbound_end_attempt($1, false) AS aborted', [
          operation.attemptId,
        ])
        return result
      }
      case 'expire': {
        const [result] = await source.query('SELECT complete_outbound_expire_attempt($1) AS expired', [
          operation.attemptId,
        ])
        return result
      }
      case 'reconcile': {
        const expired: { attempt_id: string }[] = await source.query(
          'SELECT attempt_id FROM complete_outbound_reconcile_attempts($1)',
          [operation.stage],
        )
        return { expired: expired.map(({ attempt_id }) => attempt_id) }
      }
      case 'status': {
        const [result] = await source.query(
          `SELECT r.state, r.stage, r.release_floor, r.manifest_sha256, r.evidence_sha256, r.expires_at,
            a.phase, a.api_principal, r.handed_off_from,
            (SELECT rolcanlogin FROM pg_roles WHERE rolname = r.handed_off_from) AS predecessor_can_login,
            COALESCE(a.deployment_receipt = r.id::text, false) AS current,
            CASE WHEN r.stage = 'dev' THEN
              COALESCE(a.deployment_receipt = r.id::text, false)
              AND a.phase = 'closed' AND r.state IN ('aborted', 'expired')
              AND NOT complete_outbound_rehearsal_has_checkpoint_work()
            END AS rehearsal_replacement_ready
           FROM complete_outbound_release_attempt r JOIN complete_outbound_admission a ON a.id = 1
           WHERE r.id = $1`,
          [operation.attemptId],
        )
        if (!result) throw new Error('Release admission attempt not found')
        return result
      }
    }
  } finally {
    await source.destroy()
  }
}
