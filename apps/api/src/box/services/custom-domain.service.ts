/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { CustomDomainWorkflowService, DomainAction } from './custom-domain-workflow.service'
import { CustomDomainSubscriptionService, requireDomainSubscription } from './custom-domain-subscription.service'
import {
  CUSTOM_DOMAIN_COLUMNS,
  CustomDomainRow,
  DomainDnsRecord,
  normalizeCustomHostname,
} from './custom-domain-policy'

@Injectable()
export class CustomDomainService {
  constructor(
    private readonly db: DataSource,
    private readonly config: TypedConfigService,
    private readonly subscriptions: CustomDomainSubscriptionService,
    private readonly workflow: CustomDomainWorkflowService,
  ) {}

  async list(organizationId: string) {
    const subscription = await this.subscriptions.read(organizationId)
    const rows: CustomDomainRow[] = await this.db.query(
      `SELECT ${CUSTOM_DOMAIN_COLUMNS} FROM custom_domain_config c
       WHERE organization_id = $1 AND (deleted_at IS NULL OR superseded_by IS NOT NULL) ORDER BY created_at, id`,
      [organizationId],
    )
    return {
      enabled: !!this.config.get('customDomains.enabled'),
      subscription: subscription.status,
      domains: rows.map((row) => this.view(row)),
    }
  }

  async get(organizationId: string, id: string) {
    return this.view(await this.owned(this.db.manager, organizationId, id))
  }

  async create(organizationId: string, rawHostname: unknown) {
    this.requireEnabled()
    const hostname = normalizeCustomHostname(rawHostname)
    requireDomainSubscription((await this.subscriptions.refresh(organizationId)).status)
    const id = await this.db.transaction(async (manager) => {
      await this.lockOrganization(manager, organizationId)
      const existing: CustomDomainRow[] = await manager.query(
        `SELECT * FROM custom_domain_config WHERE organization_id = $1 AND hostname = $2 AND deleted_at IS NULL FOR UPDATE`,
        [organizationId, hostname],
      )
      if (existing[0]) return existing[0].id
      // Drafts reserve the slot; create and delete hold the same organization lock.
      const [held] = await manager.query(
        `SELECT id FROM custom_domain_config WHERE organization_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [organizationId],
      )
      if (held) {
        throw new HttpException(
          {
            code: 'custom_domain_count_limit_reached',
            message:
              'Each organization can have one custom domain. Delete the existing configuration before adding another.',
          },
          400,
        )
      }
      const [budget] = await manager.query(
        `SELECT
        count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 hour') AS recent,
        count(*) FILTER (WHERE deleted_at IS NOT NULL AND cleaned_at IS NULL) AS pending
        FROM custom_domain_config WHERE organization_id = $1`,
        [organizationId],
      )
      if (Number(budget.recent) >= 10 || Number(budget.pending) >= 5)
        throw new HttpException(
          {
            code: 'domain_creation_limited',
            message: 'Wait for pending domain cleanup before creating another configuration.',
          },
          429,
        )
      const [created] = await manager.query(
        `INSERT INTO custom_domain_config
        (organization_id, hostname, challenge, challenge_expires_at) VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`,
        [organizationId, hostname, randomBytes(32).toString('hex')],
      )
      return created.id as string
    })
    await this.workflow.run(organizationId, id, 'prepare')
    return this.get(organizationId, id)
  }

  async verify(organizationId: string, id: string) {
    return this.perform(organizationId, id, 'verify')
  }

  async prepare(organizationId: string, id: string) {
    return this.perform(organizationId, id, 'prepare')
  }

  async advance(organizationId: string, id: string) {
    return this.perform(organizationId, id, 'advance')
  }

  private async perform(organizationId: string, id: string, action: DomainAction) {
    this.requireEnabled()
    const row = await this.owned(this.db.manager, organizationId, id)
    if (row.superseded_by)
      throw new HttpException(
        {
          code: 'domain_superseded',
          message: 'A newer verified application owns this hostname. Create a new configuration to verify again.',
        },
        409,
      )
    await this.workflow.run(organizationId, id, action)
    return this.get(organizationId, id)
  }

  async delete(organizationId: string, id: string): Promise<void> {
    await this.db.transaction(async (manager) => {
      await this.lockOrganization(manager, organizationId)
      const row = await this.owned(manager, organizationId, id, true)
      // Retain the execution lease: a late cloud result must still be cleaned up.
      await manager.query(
        `UPDATE custom_domain_config SET deleted_at = now(), phase = 'deleting', superseded_by = NULL,
        dns_valid_until = '-infinity', next_check_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      )
      if (row.domain_id)
        await manager.query(`DELETE FROM domain WHERE id = $1 AND organization_id = $2`, [
          row.domain_id,
          organizationId,
        ])
    })
    await this.workflow.run(organizationId, id, 'cleanup')
  }

  private async owned(
    manager: EntityManager,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<CustomDomainRow> {
    const [row]: CustomDomainRow[] = await manager.query(
      `SELECT ${CUSTOM_DOMAIN_COLUMNS} FROM custom_domain_config c
      WHERE id = $1 AND organization_id = $2 AND (deleted_at IS NULL OR superseded_by IS NOT NULL) ${lock ? 'FOR UPDATE' : ''}`,
      [id, organizationId],
    )
    if (!row) throw new NotFoundException('Custom domain configuration not found')
    return row
  }

  private async lockOrganization(manager: EntityManager, organizationId: string) {
    await manager.query(`SET LOCAL lock_timeout = '5s'`)
    const [row] = await manager.query(`SELECT id FROM organization WHERE id = $1 FOR UPDATE`, [organizationId])
    if (!row) throw new NotFoundException('Organization not found')
  }

  private requireEnabled() {
    if (!this.config.get('customDomains.enabled'))
      throw new HttpException(
        { code: 'custom_domains_unavailable', message: 'Custom domains are not configured on this deployment.' },
        503,
      )
  }

  private view(row: CustomDomainRow) {
    const dnsRecords: DomainDnsRecord[] = [
      { name: row.hostname, type: 'CNAME', value: this.config.get('customDomains.trafficHost') },
      { name: `_boxlite-verification.${row.hostname}`, type: 'TXT', value: `boxlite-verification=${row.challenge}` },
    ]
    if (row.provider_state.authorizationRecord) dnsRecords.push(row.provider_state.authorizationRecord)
    return {
      id: row.id,
      hostname: row.hostname,
      phase: row.superseded_by ? 'superseded' : row.phase,
      progress:
        row.provider_state.progress ?? (row.provider_state.authorizationRecord ? 'awaiting_dns' : 'preparing_dns'),
      confirmed: !!row.confirmed_at,
      submissionStatus: row.submission_status,
      dnsChecks: row.dns_checks,
      retryAfter:
        Math.max(
          0,
          Math.min(
            3600,
            Math.ceil(
              ((row.next_check_at instanceof Date ? row.next_check_at.getTime() : Date.now()) - Date.now()) / 1000,
            ),
          ),
        ) || 10,
      certificateState: row.provider_state.certificateState ?? 'unknown',
      certificateExpiresAt: row.certificate_expires_at,
      certificateObservedAt: row.certificate_observed_at,
      tlsCheckedAt: row.tls_checked_at,
      errorCode: row.error_code,
      ready: row.phase === 'ready' && !!row.confirmed_at && !row.deleted_at && !row.superseded_by,
      challengeExpiresAt: null,
      dnsRecords: row.provider_state.authorizationRecord ? dnsRecords : [],
    }
  }
}
