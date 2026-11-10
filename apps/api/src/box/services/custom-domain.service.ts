/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
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
  ) {}

  async list(organizationId: string) {
    const subscription = await this.subscriptions.refresh(organizationId)
    const rows: CustomDomainRow[] = await this.db.query(
      `SELECT ${CUSTOM_DOMAIN_COLUMNS} FROM custom_domain_config c
       WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
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
    const settings = this.config.getOrThrow('customDomains')
    const hostname = normalizeCustomHostname(
      rawHostname,
      [
        ...settings.reservedSuffixes,
        settings.trafficHost,
        this.config.get('domain.appHost'),
        this.config.get('proxy.domain')?.split(':')[0],
        ...[this.config.get('dashboardBaseApiUrl'), this.config.get('dashboardUrl')]
          .filter((url) => url?.startsWith('https://') || url?.startsWith('http://'))
          .map((url) => new URL(url).hostname),
      ].filter(Boolean),
    )
    requireDomainSubscription((await this.subscriptions.refresh(organizationId)).status)
    const id = await this.db.transaction(async (manager) => {
      await this.lockOrganization(manager, organizationId)
      const existing: CustomDomainRow[] = await manager.query(
        `SELECT * FROM custom_domain_config WHERE organization_id = $1 AND hostname = $2 AND deleted_at IS NULL FOR UPDATE`,
        [organizationId, hostname],
      )
      if (existing[0]) {
        // Only unverified drafts rotate challenges; verified assets retain their DNS authorization.
        await manager.query(
          `UPDATE custom_domain_config SET challenge = $2, generation = generation + 1,
          challenge_expires_at = now() + interval '1 day', next_check_at = now(), error_code = NULL
          WHERE id = $1 AND domain_id IS NULL AND challenge_expires_at <= now()`,
          [existing[0].id, randomBytes(32).toString('hex')],
        )
        return existing[0].id
      }
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
      const [created] = await manager.query(
        `INSERT INTO custom_domain_config
        (organization_id, hostname, challenge, challenge_expires_at) VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`,
        [organizationId, hostname, randomBytes(32).toString('hex')],
      )
      return created.id as string
    })
    return this.get(organizationId, id)
  }

  async verify(organizationId: string, id: string) {
    this.requireEnabled()
    await this.owned(this.db.manager, organizationId, id)
    requireDomainSubscription((await this.subscriptions.refresh(organizationId)).status)
    await this.db.query(
      `UPDATE custom_domain_config SET next_check_at = CASE
        WHEN error_code IN ('provider_capacity_exhausted', 'provider_permission_denied', 'provider_resource_conflict')
          THEN next_check_at ELSE now() END
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [id, organizationId],
    )
    return this.get(organizationId, id)
  }

  async delete(organizationId: string, id: string): Promise<void> {
    await this.db.transaction(async (manager) => {
      await this.lockOrganization(manager, organizationId)
      const row = await this.owned(manager, organizationId, id, true)
      // Do not clear a worker lease: its late cloud result must be followed by cleanup.
      await manager.query(
        `UPDATE custom_domain_config SET deleted_at = now(), phase = 'deleting',
        dns_valid_until = '-infinity', next_check_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      )
      if (row.domain_id)
        await manager.query(`DELETE FROM domain WHERE id = $1 AND organization_id = $2`, [
          row.domain_id,
          organizationId,
        ])
    })
  }

  private async owned(
    manager: EntityManager,
    organizationId: string,
    id: string,
    lock = false,
  ): Promise<CustomDomainRow> {
    const [row]: CustomDomainRow[] = await manager.query(
      `SELECT ${CUSTOM_DOMAIN_COLUMNS} FROM custom_domain_config c
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
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
      phase: row.phase,
      errorCode: row.error_code,
      ready: row.phase === 'ready' && row.dns_valid && row.certificate_valid,
      challengeExpiresAt: row.domain_id ? null : row.challenge_expires_at,
      dnsRecords,
    }
  }
}
