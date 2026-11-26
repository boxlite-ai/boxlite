/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import type { EntityManager } from 'typeorm'

export class AccountLinkSignupPendingException extends ConflictException {
  constructor() {
    super({
      code: 'account_link_pending',
      message: 'Your account link is still being confirmed. Try again shortly.',
    })
  }
}

export class AccountLinkSourceSupersededException extends ConflictException {
  constructor() {
    super({
      code: 'account_link_superseded',
      message: 'This sign-in predates an account link. Please sign in again.',
    })
  }
}

// An incoming link and first registration must serialize even before the user row exists.
export async function lockAccountLinkIdentities(em: EntityManager, ...ids: string[]): Promise<void> {
  for (const id of ids.sort()) {
    await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`account-link:${id}`])
  }
}

export async function assertAccountLinkAllowsSignup(
  em: EntityManager,
  userId: string,
  tokenIssuedAt?: number,
): Promise<void> {
  await lockAccountLinkIdentities(em, userId)
  const [completed] = await em.query(
    `SELECT 1 FROM "account_link_consent_job"
     WHERE "source_id" = $1 AND "state" = 'done'
       AND ($2::numeric IS NULL OR EXTRACT(EPOCH FROM "completed_at") >= $2)
     LIMIT 1`,
    [userId, Number.isSafeInteger(tokenIssuedAt) ? tokenIssuedAt : null],
  )
  if (completed) throw new AccountLinkSourceSupersededException()

  const [incoming] = await em.query(
    `SELECT 1
     FROM "account_link_consent_job" AS job
     JOIN "organization_user" AS membership
       ON membership."userId" = job."source_id" AND membership."isDefaultForUser"
     WHERE job."target_id" = $1 AND job."state" = 'pending'
       AND NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = $1)
     LIMIT 1`,
    [userId],
  )
  if (incoming) throw new AccountLinkSignupPendingException()
}
