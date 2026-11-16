/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { HttpException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { CustomDomainSubscriptionService, requireDomainSubscription } from './custom-domain-subscription.service'
import { CustomDomainDnsService, DomainSetupError } from './custom-domain-dns.service'
import { CustomDomainGcpService } from './custom-domain-gcp.service'
import { CustomDomainRow } from './custom-domain-policy'

export type DomainAction = 'prepare' | 'verify' | 'advance' | 'cleanup' | 'observe'

/** Awaited, durable steps shared by explicit requests and the API task. */
@Injectable()
export class CustomDomainWorkflowService {
  constructor(
    private readonly db: DataSource,
    private readonly config: TypedConfigService,
    private readonly subscriptions: CustomDomainSubscriptionService,
    private readonly dns: CustomDomainDnsService,
    private readonly provider: CustomDomainGcpService,
  ) {}

  async run(organizationId: string, id: string, action: DomainAction): Promise<void> {
    if (!this.config.get('customDomains.enabled')) return
    const row = await this.claim(organizationId, id, action)
    if (!row) return
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 25_000)
    try {
      if (row.deleted_at) {
        await this.save(row, await this.provider.reconcile(row, 'advance', abort.signal))
        return
      }
      if (action === 'observe') {
        if (row.phase !== 'ready') return
        const observation = await this.provider.reconcile(row, 'observe', abort.signal)
        await this.query(
          `UPDATE custom_domain_config SET certificate_observed_at = clock_timestamp(),
          certificate_expires_at = COALESCE($4::timestamptz, certificate_expires_at), provider_state = $5
          WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > clock_timestamp()
            AND deleted_at IS NULL AND superseded_by IS NULL`,
          [
            row.id,
            row.generation,
            row.lease_owner,
            observation.expires,
            { ...row.provider_state, certificateState: observation.state.certificateState },
          ],
        )
        await this.dns.verifyTls(row.hostname, abort.signal)
        await this.query(
          `UPDATE custom_domain_config SET tls_checked_at = clock_timestamp(),
          error_code = $4, next_check_at = clock_timestamp() + interval '1 hour'
          WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > clock_timestamp()
            AND deleted_at IS NULL AND superseded_by IS NULL`,
          [
            row.id,
            row.generation,
            row.lease_owner,
            observation.state.certificateState === 'FAILED' ? 'certificate_renewal_failed' : null,
          ],
        )
        return
      }
      // Completed setup never needs an idle-time DNS/TLS refresh to remain routable.
      if (row.phase === 'ready' && row.confirmed_at) return
      const grant = await this.subscriptions.refresh(organizationId)
      requireDomainSubscription(grant.status)
      if (action === 'prepare') {
        if (row.confirmed_at || row.provider_state.authorizationRecord) return
        let result = await this.provider.reconcile(row, 'prepare', abort.signal)
        await this.save(row, result)
        // One immediate read after creation can deliver all records in the initial response.
        if (!result.state.authorizationRecord && !abort.signal.aborted) {
          row.provider_state = result.state
          result = await this.provider.reconcile(row, 'prepare', abort.signal)
          await this.save(row, result)
        }
        return
      }
      if (!row.confirmed_at) {
        if (action !== 'verify') throw new DomainSetupError('confirmation_required')
        if (!row.provider_state.authorizationRecord) throw new DomainSetupError('dns_configuration_pending')
        const checks = await this.dns.checkAll(
          row.hostname,
          row.challenge,
          row.provider_state.authorizationRecord,
          abort.signal,
        )
        await this.query(
          `UPDATE custom_domain_config SET dns_checks = $4, dns_checked_at = clock_timestamp()
          WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > clock_timestamp()
            AND deleted_at IS NULL AND superseded_by IS NULL`,
          [row.id, row.generation, row.lease_owner, JSON.stringify(checks)],
        )
        const failed = checks.find((check) => check.status !== 'passed')
        if (failed) throw new DomainSetupError(failed.errorCode)
        if (!(await this.admit(row, grant.expiresAt))) return
        row.confirmed_at = new Date()
        row.submission_status = 'unknown'
      }
      // Persist intent before a potentially successful, lost certificate POST response.
      if (row.submission_status !== 'accepted') {
        const changed = await this.query(
          `UPDATE custom_domain_config SET submission_status = 'unknown'
          WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > clock_timestamp()
            AND deleted_at IS NULL AND superseded_by IS NULL RETURNING id`,
          [row.id, row.generation, row.lease_owner],
        )
        if (!changed.length) return
      } else if (await this.cleanPredecessor(row, abort.signal)) {
        return
      }
      const result = await this.provider.reconcile(row, 'advance', abort.signal)
      if (result.phase === 'ready') {
        // Save provider observations before probing: a probe timeout must not lose cloud progress.
        await this.save(row, { ...result, phase: 'provisioning' })
        const servedExpiry = await this.dns.verifyTls(row.hostname, abort.signal)
        result.expires = new Date(Math.min(Date.parse(result.expires), Date.parse(servedExpiry))).toISOString()
        result.state.progress = 'ready'
      }
      await this.save(row, result)
    } catch (error) {
      const response = error instanceof HttpException ? (error.getResponse() as { code?: string }) : undefined
      const code = error instanceof DomainSetupError ? error.code : (response?.code ?? 'verification_unavailable')
      await this.query(
        `UPDATE custom_domain_config SET error_code = $4, attempts = attempts + 1,
        submission_status = CASE WHEN $5 AND submission_status <> 'accepted' THEN 'not_submitted' ELSE submission_status END,
        next_check_at = clock_timestamp() + make_interval(secs => LEAST(3600, 10 * power(2, LEAST(attempts, 9)))::int)
        WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > clock_timestamp()`,
        [row.id, row.generation, row.lease_owner, code, error instanceof DomainSetupError && error.submissionRejected],
      )
    } finally {
      clearTimeout(timer)
      abort.abort()
      await this.query(
        `UPDATE custom_domain_config SET lease_owner = NULL, lease_until = '-infinity'
        WHERE id = $1 AND lease_owner = $2`,
        [row.id, row.lease_owner],
      )
    }
  }

  private async query(sql: string, parameters: unknown[] = []) {
    return this.db.transaction(async (manager) => {
      await manager.query(`SET LOCAL statement_timeout = '2s'`)
      return manager.query(sql, parameters)
    })
  }

  private async claim(org: string, id: string, action: DomainAction): Promise<CustomDomainRow | undefined> {
    return this.db.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '2s'`)
      await manager.query(`SET LOCAL statement_timeout = '2s'`)
      await manager.query(`SELECT pg_advisory_xact_lock(1793764800)`)
      const [row]: CustomDomainRow[] = await manager.query(
        `SELECT c.* FROM custom_domain_config c
        WHERE c.id = $1 AND c.organization_id = $2 AND c.lease_until <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM custom_domain_config busy WHERE busy.hostname = c.hostname
            AND busy.lease_until > clock_timestamp()) FOR UPDATE`,
        [id, org],
      )
      if (!row || (row.deleted_at && !['cleanup', 'advance'].includes(action))) return
      if (
        (action === 'advance' || (action === 'verify' && row.confirmed_at)) &&
        row.next_check_at instanceof Date &&
        row.next_check_at.getTime() > Date.now()
      )
        return
      if (
        ['prepare', 'verify'].includes(action) &&
        row.error_code?.startsWith('provider_') &&
        row.next_check_at > new Date()
      )
        return
      row.lease_owner = randomUUID()
      await manager.query(
        `UPDATE custom_domain_config SET lease_owner = $2,
        lease_until = clock_timestamp() + interval '45 seconds', last_action_at = clock_timestamp()
        WHERE id = $1`,
        [id, row.lease_owner],
      )
      return row
    })
  }

  private async admit(row: CustomDomainRow, expiresAt: number): Promise<boolean> {
    return this.db.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '2s'`)
      await manager.query(`SET LOCAL statement_timeout = '2s'`)
      await manager.query(`SELECT id FROM organization WHERE id = $1 FOR UPDATE`, [row.organization_id])
      const [current] = await manager.query(
        `SELECT * FROM custom_domain_config WHERE id = $1
        AND generation = $2 AND lease_owner = $3 AND lease_until > clock_timestamp()
        AND deleted_at IS NULL AND superseded_by IS NULL FOR UPDATE`,
        [row.id, row.generation, row.lease_owner],
      )
      if (!current) return false
      const [grant] = await manager.query(`SELECT $1::timestamptz > clock_timestamp() AS valid`, [new Date(expiresAt)])
      if (!grant.valid) throw new DomainSetupError('subscription_not_ready')
      if (current.confirmed_at) return true
      const [held] = await manager.query(`SELECT * FROM domain WHERE hostname = $1 FOR UPDATE`, [row.hostname])
      if (held?.kind === 'platform') throw new DomainSetupError('domain_already_owned')
      // Invalidate old generations before changing domain ownership. Retain their resource IDs for cleanup.
      await manager.query(
        `UPDATE custom_domain_config SET superseded_by = $2, deleted_at = clock_timestamp(),
        phase = 'deleting', domain_id = NULL, next_check_at = clock_timestamp(), error_code = 'domain_superseded'
        WHERE hostname = $1 AND id <> $2 AND deleted_at IS NULL`,
        [row.hostname, row.id],
      )
      const [domain] = await manager.query(
        `INSERT INTO domain (hostname, kind, organization_id)
        VALUES ($1, 'custom', $2) ON CONFLICT (hostname) DO UPDATE SET organization_id = EXCLUDED.organization_id,
        box_id = NULL, app_id = NULL, port = NULL, target_type = 'box', updated_at = clock_timestamp() RETURNING id`,
        [row.hostname, row.organization_id],
      )
      // Also release a legacy config's unique domain_id before attaching the new winner.
      await manager.query(`UPDATE custom_domain_config SET domain_id = NULL WHERE domain_id = $1 AND id <> $2`, [
        domain.id,
        row.id,
      ])
      await manager.query(
        `UPDATE custom_domain_config SET domain_id = $2, confirmed_at = clock_timestamp(),
        phase = 'provisioning', submission_status = 'unknown', error_code = NULL WHERE id = $1`,
        [row.id, domain.id],
      )
      row.domain_id = domain.id
      return true
    })
  }

  private async save(
    row: CustomDomainRow,
    result: { state: CustomDomainRow['provider_state']; phase: string; expires: string | null; cleaned: boolean },
  ) {
    await this.query(
      `UPDATE custom_domain_config c SET provider_state = $4,
      phase = CASE WHEN deleted_at IS NOT NULL THEN 'deleting' ELSE $5 END,
      submission_status = CASE WHEN $6 THEN 'accepted' ELSE submission_status END,
      certificate_expires_at = COALESCE($7::timestamptz, certificate_expires_at),
      certificate_observed_at = CASE WHEN $9 THEN clock_timestamp() ELSE certificate_observed_at END,
      tls_checked_at = CASE WHEN $5 = 'ready' THEN clock_timestamp() ELSE tls_checked_at END,
      cleaned_at = CASE WHEN $8 THEN clock_timestamp() ELSE cleaned_at END,
      error_code = CASE WHEN superseded_by IS NOT NULL THEN 'domain_superseded' ELSE NULL END,
      attempts = 0, updated_at = clock_timestamp(), next_check_at = clock_timestamp() + interval '10 seconds'
      WHERE c.id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > clock_timestamp()
        AND ($5 <> 'ready' OR (c.deleted_at IS NULL AND c.superseded_by IS NULL AND c.confirmed_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM domain d WHERE d.id = c.domain_id AND d.organization_id = c.organization_id)))`,
      [
        row.id,
        row.generation,
        row.lease_owner,
        result.state,
        result.phase,
        !!result.state.certificateSubmitted,
        result.expires,
        result.cleaned,
        !!result.state.certificateState,
      ],
    )
  }

  private async cleanPredecessor(row: CustomDomainRow, signal: AbortSignal): Promise<boolean> {
    const [old]: CustomDomainRow[] = await this.query(
      `SELECT * FROM custom_domain_config
      WHERE hostname = $1 AND deleted_at IS NOT NULL AND cleaned_at IS NULL AND id <> $2 ORDER BY created_at LIMIT 1`,
      [row.hostname, row.id],
    )
    if (!old) return false
    // The winner holds the hostname lease; a tombstone cannot concurrently be claimed.
    const result = await this.provider.reconcile(old, 'advance', signal)
    await this.query(
      `UPDATE custom_domain_config SET provider_state = $2,
      cleaned_at = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END
      WHERE id = $1 AND deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM custom_domain_config
        WHERE id = $4 AND lease_owner = $5 AND lease_until > clock_timestamp() AND deleted_at IS NULL)`,
      [old.id, result.state, result.cleaned, row.id, row.lease_owner],
    )
    return true
  }

  async advancePending(): Promise<void> {
    if (!this.config.get('customDomains.enabled') || this.config.get('skipConnections')) return
    const rows: CustomDomainRow[] = await this.query(`SELECT c.* FROM custom_domain_config c
      WHERE c.confirmed_at IS NOT NULL AND c.deleted_at IS NULL AND c.superseded_by IS NULL
        AND c.phase IN ('pending_verification', 'pending_certificate_dns', 'provisioning')
        AND c.next_check_at <= clock_timestamp() AND c.lease_until <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM custom_domain_config busy WHERE busy.hostname = c.hostname
          AND busy.lease_until > clock_timestamp())
      ORDER BY c.next_check_at, c.id LIMIT 3`)
    // Selection is advisory; run() acquires the same hostname lease used by requests.
    const results = await Promise.allSettled(rows.map((row) => this.run(row.organization_id, row.id, 'advance')))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Domain advancement failed',
      )
  }

  /** One recoverable maintenance round, shared by the API task and admin trigger. */
  async maintain(): Promise<void> {
    if (!this.config.get('customDomains.enabled') || this.config.get('skipConnections')) return
    await this
      .query(`UPDATE custom_domain_config SET deleted_at = clock_timestamp(), phase = 'deleting', next_check_at = clock_timestamp()
      WHERE id IN (SELECT id FROM custom_domain_config
        WHERE deleted_at IS NULL AND confirmed_at IS NULL AND domain_id IS NULL
          AND last_action_at < clock_timestamp() - interval '30 days' AND lease_until <= clock_timestamp()
        ORDER BY last_action_at, id LIMIT 50 FOR UPDATE SKIP LOCKED)`)
    const rows: CustomDomainRow[] = await this.query(`SELECT * FROM custom_domain_config WHERE
      (next_check_at <= clock_timestamp() OR next_check_at = 'infinity') AND ((deleted_at IS NOT NULL AND (cleaned_at IS NULL OR cleaned_at < clock_timestamp() - interval '1 day'))
      OR (phase = 'ready' AND deleted_at IS NULL AND COALESCE(tls_checked_at, '-infinity') < clock_timestamp() - interval '1 hour'))
      ORDER BY COALESCE(tls_checked_at, cleaned_at, created_at), id LIMIT 1`)
    for (const row of rows) await this.run(row.organization_id, row.id, row.deleted_at ? 'cleanup' : 'observe')
  }
}
