/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'
import { AuditLog } from '../audit/entities/audit-log.entity'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { RegistrationConsent } from '../user/registration-consent.entity'
import { User } from '../user/user.entity'
import { lockAccountLinkIdentities } from '../user/account-link-registration'
import { AccountLinkAuth0Reader } from './account-link-auth0-reader.service'

export interface AccountLinkOperation {
  id: string
  source_id: string
  target_id: string
}

export type AccountLinkResult = 'done' | 'failed'

export interface AccountLinkPreparation {
  operationId: string
  ready: boolean
  dispatchUntil?: number
}

interface Attempt {
  id: string
  dispatch_until: Date
  rejected: boolean
}

interface RetryCandidate extends AccountLinkOperation {
  attempt_id: string
}

type CompletionEvidence = { attemptId: string } | { leaseToken: string }

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
    private readonly auth0: AccountLinkAuth0Reader,
  ) {}

  async prepare(request: AccountLinkOperation): Promise<AccountLinkPreparation> {
    const { id, source_id: source, target_id: target } = request
    const retry = await this.checkRetry(request)
    return this.dataSource.transaction(async (em) => {
      await lockAccountLinkIdentities(em, source, target)

      const [previous]: (Attempt & LinkJob)[] = await em.query(
        `SELECT job.*, attempt."dispatch_until", attempt."rejected" FROM "account_link_attempt" AS attempt
         JOIN "account_link_consent_job" AS job ON job."id" = attempt."operation_id"
         WHERE attempt."id" = $1`,
        [id],
      )
      if (previous) {
        if (previous.source_id !== source || previous.target_id !== target) {
          throw new ConflictException('The account-link attempt names different accounts.')
        }
        const dispatchUntil = previous.dispatch_until.getTime()
        if (previous.state === 'pending' && !previous.rejected && dispatchUntil > Date.now()) {
          return { operationId: previous.id, ready: true, dispatchUntil }
        }
        return { operationId: previous.id, ready: false }
      }

      const [active]: LinkJob[] = await em.query(
        `SELECT * FROM "account_link_consent_job" WHERE "source_id" = $1
         AND "state" = 'pending' FOR UPDATE`,
        [source],
      )
      if (active?.target_id === target) {
        const [latest]: Attempt[] = await em.query(
          `SELECT "id", "dispatch_until" FROM "account_link_attempt" WHERE "operation_id" = $1
           ORDER BY "dispatch_until" DESC LIMIT 1`,
          [active.id],
        )
        if (retry?.eligible && retry.id === active.id && retry.attempt_id === latest?.id) {
          return this.reserveAttempt(em, active.id, id)
        }
        return { operationId: active.id, ready: false }
      }
      if (retry && !active) return { operationId: retry.id, ready: false }

      const [overlap] = await em.query(
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
      return this.reserveAttempt(em, id, id)
    })
  }

  private async checkRetry(
    request: AccountLinkOperation,
  ): Promise<(RetryCandidate & { eligible: boolean }) | undefined> {
    const [candidate]: RetryCandidate[] = await this.dataSource.query(
      `SELECT job."id", job."source_id", job."target_id", latest."id" AS "attempt_id"
       FROM "account_link_consent_job" AS job
       CROSS JOIN LATERAL (
         SELECT "id", "dispatch_until" FROM "account_link_attempt" WHERE "operation_id" = job."id"
         ORDER BY "dispatch_until" DESC LIMIT 1
       ) AS latest
       WHERE job."state" = 'pending' AND job."source_id" = $1 AND job."target_id" = $2
         AND latest."id" <> $3 AND latest."dispatch_until" + interval '1 minute' <= clock_timestamp()`,
      [request.source_id, request.target_id, request.id],
    )
    if (!candidate) return
    try {
      return { ...candidate, eligible: !(await this.auth0.linkExists(candidate)) }
    } catch {
      // A non-authoritative read leaves the original operation in progress.
      this.logger.debug(`Could not check account link ${candidate.id} for another attempt`)
      return { ...candidate, eligible: false }
    }
  }

  private async reserveAttempt(em: EntityManager, operationId: string, id: string): Promise<AccountLinkPreparation> {
    const [attempt]: Attempt[] = await em.query(
      `INSERT INTO "account_link_attempt" ("id", "operation_id", "dispatch_until")
       VALUES ($1, $2, clock_timestamp() + interval '30 seconds') RETURNING "dispatch_until"`,
      [id, operationId],
    )
    return { operationId, ready: true, dispatchUntil: attempt.dispatch_until.getTime() }
  }

  async complete(
    operation: AccountLinkOperation,
    outcome: AccountLinkResult,
    evidence: CompletionEvidence = { attemptId: operation.id },
  ): Promise<void> {
    const keys = await this.dataSource.transaction(async (em) => {
      await lockAccountLinkIdentities(em, operation.source_id, operation.target_id)
      const [job]: LinkJob[] = await em.query(
        `SELECT * FROM "account_link_consent_job" WHERE "id" = $1
         AND "source_id" = $2 AND "target_id" = $3 FOR UPDATE`,
        [operation.id, operation.source_id, operation.target_id],
      )
      if (!job) throw new NotFoundException('Account-link operation not found.')
      if (job.state !== 'pending') return []
      if ('leaseToken' in evidence) {
        const [current] = await em.query(
          `SELECT 1 FROM "account_link_consent_job" WHERE "id" = $1
           AND "lease_token" = $2 AND "lease_expires_at" > clock_timestamp()`,
          [job.id, evidence.leaseToken],
        )
        if (!current) return []
      } else {
        const { attemptId } = evidence
        const [attempt] = await em.query(
          'SELECT "id" FROM "account_link_attempt" WHERE "operation_id" = $1 AND "id" = $2',
          [job.id, attemptId],
        )
        if (!attempt) throw new NotFoundException('Account-link attempt not found.')
        if (outcome === 'failed') {
          await em.query('UPDATE "account_link_attempt" SET "rejected" = true WHERE "id" = $1', [attemptId])
          const [unresolved] = await em.query(
            'SELECT 1 FROM "account_link_attempt" WHERE "operation_id" = $1 AND NOT "rejected" LIMIT 1',
            [job.id],
          )
          if (unresolved) return []
        }
      }

      let movedKeys: string[] = []
      if (outcome === 'done') {
        movedKeys = await this.linkedIdentity.adoptInTransaction(
          em,
          job.target_id,
          job.source_id,
          Boolean(this.config.get('legal')),
        )
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
      await em.insert(
        AuditLog,
        new AuditLog({
          actorId: job.target_id,
          actorEmail: '',
          action: AuditAction.LINK_ACCOUNT,
          targetType: AuditTarget.USER,
          targetId: job.source_id,
          source: 'auth0-account-link',
          statusCode: outcome === 'done' ? 204 : 409,
          metadata: {
            scope: 'local_ownership',
            primaryUserId: job.target_id,
            secondaryUserId: job.source_id,
            operationId: job.id,
            outcome,
            ...('attemptId' in evidence ? { attemptId: evidence.attemptId } : {}),
          },
        }),
      )
      return movedKeys
    })
    await this.linkedIdentity.forgetCachedOwners(keys)
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
