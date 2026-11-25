/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { RegistrationConsent } from '../user/registration-consent.entity'
import { User } from '../user/user.entity'

export interface AccountLinkOperation {
  id: string
  source_id: string
  target_id: string
}

export type AccountLinkResult = 'done' | 'failed'

interface LinkJob extends AccountLinkOperation {
  state: 'pending' | AccountLinkResult
  attempts: number
}

export interface AccountLinkLease extends LinkJob {
  lease_token: string
}

@Injectable()
export class AccountLinkConsentJobs {
  private readonly logger = new Logger(AccountLinkConsentJobs.name)

  constructor(
    private readonly dataSource: DataSource,
    private readonly linkedIdentity: LinkedIdentityService,
    private readonly config: TypedConfigService,
  ) {}

  async prepare(operation: AccountLinkOperation): Promise<{ operationId: string; ready: boolean }> {
    const { id, source_id: source, target_id: target } = operation
    const result = await this.dataSource.transaction(async (em) => {
      // Lock names as well as existing users. A new target may not have a row yet.
      for (const identity of [source, target].sort()) {
        await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`account-link:${identity}`])
      }

      const [retried]: LinkJob[] = await em.query('SELECT * FROM "account_link_consent_job" WHERE "id" = $1', [id])
      if (retried) {
        if (retried.source_id !== source || retried.target_id !== target) {
          throw new ConflictException('The account-link operation names different accounts.')
        }
        return { operationId: id, ready: retried.state === 'pending', keys: [] }
      }

      const [active]: LinkJob[] = await em.query(
        `SELECT * FROM "account_link_consent_job" WHERE "source_id" = $1
         AND "state" = 'pending'`,
        [source],
      )
      if (active?.target_id === target) {
        return { operationId: active.id, ready: false, keys: [] }
      }

      const [overlap]: LinkJob[] = await em.query(
        `SELECT "id" FROM "account_link_consent_job"
         WHERE ("state" = 'pending' AND ("source_id" = $1 OR "target_id" = $1))
            OR ("state" IN ('pending', 'done') AND "source_id" = $2)
         LIMIT 1`,
        [source, target],
      )
      if (overlap) throw new ConflictException('An overlapping account link must be resolved first.')

      await em.query('INSERT INTO "account_link_consent_job" ("id", "source_id", "target_id") VALUES ($1, $2, $3)', [
        id,
        source,
        target,
      ])
      const keys = await this.linkedIdentity.adoptInTransaction(em, target, source, Boolean(this.config.get('legal')))
      return { operationId: id, ready: true, keys }
    })
    await this.linkedIdentity.forgetCachedOwners(result.keys)
    return { operationId: result.operationId, ready: result.ready }
  }

  async complete(operation: AccountLinkOperation, outcome: AccountLinkResult, lease?: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const [job]: LinkJob[] = await em.query(
        `SELECT * FROM "account_link_consent_job" WHERE "id" = $1
         AND "source_id" = $2 AND "target_id" = $3 FOR UPDATE`,
        [operation.id, operation.source_id, operation.target_id],
      )
      if (!job) throw new NotFoundException('Account-link operation not found.')
      if (job.state !== 'pending') return
      if (lease) {
        const [current] = await em.query(
          `SELECT 1 FROM "account_link_consent_job" WHERE "id" = $1
           AND "lease_token" = $2 AND "lease_expires_at" > clock_timestamp()`,
          [job.id, lease],
        )
        if (!current) return
      }

      if (outcome === 'done') {
        const target = await em.findOne(User, { where: { id: job.target_id }, lock: { mode: 'pessimistic_write' } })
        const source = await em.findOneBy(RegistrationConsent, { userId: job.source_id })
        if (!target && source) throw new ConflictException('The account-link target has no local account.')
        if (target) {
          const targetConsent = await em.existsBy(RegistrationConsent, { userId: target.id })
          if (source && !targetConsent) {
            await em.update(RegistrationConsent, { id: source.id }, { userId: target.id })
          }
          if (target.registrationConsentPending && (targetConsent || source)) {
            await em.update(User, { id: target.id }, { registrationConsentPending: false })
          }
        }
      }
      await em.query(
        `UPDATE "account_link_consent_job"
         SET "state" = $2, "lease_token" = NULL, "lease_expires_at" = NULL WHERE "id" = $1`,
        [job.id, outcome],
      )
    })
  }

  async claim(): Promise<AccountLinkLease[]> {
    return this.dataSource.transaction((em) =>
      em
        .query(
          `WITH due AS (
           SELECT "id" FROM "account_link_consent_job"
           WHERE "state" = 'pending' AND "next_check_at" <= now()
             AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= now())
           ORDER BY "next_check_at", "id" LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         UPDATE "account_link_consent_job" AS job
         SET "lease_token" = $1, "lease_expires_at" = now() + interval '1 minute'
         FROM due WHERE job."id" = due."id" RETURNING job.*`,
          [randomUUID()],
        )
        .then(([jobs]: [AccountLinkLease[], number]) => jobs),
    )
  }

  async defer(job: AccountLinkLease): Promise<void> {
    const attempts = job.attempts + 1
    const delaySeconds = attempts >= 6 ? 3600 : Math.min(60 * 2 ** (attempts - 1), 900)
    const [changed]: [{ id: string }[], number] = await this.dataSource.query(
      `UPDATE "account_link_consent_job"
       SET "attempts" = $3, "next_check_at" = now() + $4 * interval '1 second',
           "lease_token" = NULL, "lease_expires_at" = NULL
       WHERE "id" = $1 AND "lease_token" = $2 AND "state" = 'pending'
         AND "lease_expires_at" > clock_timestamp() RETURNING "id"`,
      [job.id, job.lease_token, attempts, delaySeconds],
    )
    if (changed.length && attempts === 6) this.logger.warn(`Account link ${job.id} remains unconfirmed`)
  }
}
