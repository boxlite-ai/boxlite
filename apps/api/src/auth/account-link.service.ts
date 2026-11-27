/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import {
  AccountLinkConsentJobs,
  AccountLinkOperation,
  AccountLinkPreparation,
} from './account-link-consent-jobs.service'
import { AuditService } from '../audit/services/audit.service'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { jwtVerify } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { UserService } from '../user/user.service'

/** The audiences the Action signs its requests for, one per endpoint. */
export const ADOPT_AUDIENCE = 'boxlite-account-link-adopt'
export const STATUS_AUDIENCE = 'boxlite-account-link-status'
export const PREPARE_AUDIENCE = 'boxlite-account-link-prepare'
export const RESULT_AUDIENCE = 'boxlite-account-link-result'

/** Who an adopt request names. */
export interface AdoptRequest {
  primaryUserId: string
  secondaryUserId: string
}

// An Auth0 user id: the provider, a bar, and the provider's own id.
const USER_ID = /^[^|\s]+\|\S+$/
const OPERATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID.test(value)
}

/**
 * The API's part of the login-time account link, which merges a person's
 * logins into one account.
 *
 * The Post-Login Action proves the person holds both accounts and links them
 * inside Auth0. The Action signs both identities and first reserves an attempt.
 * BoxLite moves its rows once the Action or the reconciler confirms the link.
 */
@Injectable()
export class AccountLinkService {
  private readonly logger = new Logger(AccountLinkService.name)

  constructor(
    private readonly configService: TypedConfigService,
    private readonly linkedIdentity: LinkedIdentityService,
    private readonly userService: UserService,
    private readonly audit: AuditService,
    private readonly consentJobs: AccountLinkConsentJobs,
  ) {}

  async prepare(token: string): Promise<AccountLinkPreparation> {
    const payload = await this.readRequest(token, PREPARE_AUDIENCE)
    const operation = this.operation(payload)
    const result = await this.consentJobs.prepare(operation)
    await this.audit.createLog({
      actorId: operation.target_id,
      actorEmail: '',
      action: AuditAction.LINK_ACCOUNT,
      targetType: AuditTarget.USER,
      targetId: operation.source_id,
      source: 'auth0-account-link',
      statusCode: 201,
      metadata: {
        scope: 'link_preparation',
        operationId: result.operationId,
        attemptId: operation.id,
        ready: result.ready,
      },
    })
    return result
  }

  async result(token: string): Promise<void> {
    const payload = await this.readRequest(token, RESULT_AUDIENCE)
    const operation = this.operation(payload)
    const attemptId = payload.attempt_id ?? operation.id
    if (typeof attemptId !== 'string' || !OPERATION_ID.test(attemptId)) {
      throw new UnauthorizedException('The account-link attempt is not valid.')
    }
    if (payload.outcome !== 'done' && payload.outcome !== 'failed') {
      throw new UnauthorizedException('The account-link result is not valid.')
    }
    await this.consentJobs.complete(operation, payload.outcome, { attemptId })
  }

  private operation(payload: Record<string, unknown> & { sub: string }): AccountLinkOperation {
    const { sub, primary_user_id: target, operation_id: id } = payload
    if (!isUserId(target) || target === sub || typeof id !== 'string' || !OPERATION_ID.test(id)) {
      throw new UnauthorizedException('The account-link operation is not valid.')
    }
    return { id, source_id: sub, target_id: target }
  }

  /** Move the BoxLite data of the user the token names to the account that stays. */
  async adopt(token: string): Promise<AdoptRequest> {
    const payload = await this.readRequest(token, ADOPT_AUDIENCE)
    const secondaryUserId = payload.sub
    const primaryUserId = payload.primary_user_id
    if (!isUserId(primaryUserId) || primaryUserId === secondaryUserId) {
      throw new UnauthorizedException('The account-link request does not name two accounts.')
    }
    if (this.configService.get('legal')) {
      throw new ConflictException('The Auth0 Action must prepare a consent operation before linking accounts.')
    }
    return this.recordAdoption(primaryUserId, secondaryUserId, async () => {
      await this.linkedIdentity.adopt(primaryUserId, secondaryUserId)
      return { primaryUserId, secondaryUserId }
    })
  }

  private async recordAdoption<T>(
    primaryUserId: string,
    secondaryUserId: string,
    prepare: () => Promise<T>,
  ): Promise<T> {
    const log = await this.audit.createLog({
      actorId: primaryUserId,
      actorEmail: '',
      action: AuditAction.LINK_ACCOUNT,
      targetType: AuditTarget.USER,
      targetId: secondaryUserId,
      source: 'auth0-account-link',
      metadata: { primaryUserId, secondaryUserId, scope: 'local_ownership' },
    })
    let result: T
    try {
      result = await prepare()
    } catch (error) {
      await this.audit
        .updateLog(log.id, { statusCode: 500, errorMessage: 'Local account adoption failed.' })
        .catch(() => this.logger.error(`Failed to record account adoption result for audit ${log.id}`))
      throw error
    }
    await this.audit
      .updateLog(log.id, { statusCode: 204 })
      .catch(() => this.logger.error(`Failed to record account adoption result for audit ${log.id}`))
    return result
  }

  /** Whether BoxLite has the user the token names, that is, whether it has signed in before. */
  async status(token: string): Promise<{ known: boolean }> {
    const { sub } = await this.readRequest(token, STATUS_AUDIENCE)
    return { known: (await this.userService.findOne(sub)) !== null }
  }

  private async readRequest(token: string, audience: string): Promise<Record<string, unknown> & { sub: string }> {
    const key = new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.secret'))
    let payload: Record<string, unknown>
    try {
      ;({ payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        audience,
        requiredClaims: ['sub', 'iat', 'exp'],
        maxTokenAge: '60s',
        // The Action runs on Auth0's clock, not this host's.
        clockTolerance: 5,
      }))
    } catch {
      throw new UnauthorizedException('The account-link request is not valid.')
    }
    const sub = payload.sub
    if (!isUserId(sub)) {
      throw new UnauthorizedException('The account-link request does not name an account.')
    }
    return { ...payload, sub }
  }
}
