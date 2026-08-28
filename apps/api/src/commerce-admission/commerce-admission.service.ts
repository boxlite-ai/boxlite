/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { TypedConfigService } from '../config/typed-config.service'

const MAX_ATTEMPTS = 2

export type CommerceAdmissionScenario = 'CREATE-BOX' | 'START-BOX'

export type BoxAdmissionResources = {
  cpu: number
  gpu: number
  mem: number
  disk: number
}

export type CommerceAdmissionRequest = {
  scenario: CommerceAdmissionScenario
  organizationId: string
  resources: BoxAdmissionResources
}

export type CommerceAdmissionReservation = {
  organizationId: string
  reservationId: string
}

type AdmissionDecision =
  | {
      admission: true
      reason: 'SUFFICIENT_AVAILABLE_CREDIT'
      reservationId: string
      requiredCreditCents: string
      effectiveAvailableCreditCents: string
    }
  | {
      admission: false
      reason: 'INSUFFICIENT_AVAILABLE_CREDIT' | 'STALE_USAGE_SNAPSHOT'
      requiredCreditCents: string
      effectiveAvailableCreditCents: string
    }

type CommerceAdmissionDenialReason = 'INSUFFICIENT_AVAILABLE_CREDIT' | 'STALE_USAGE_SNAPSHOT'

export class CommerceAdmissionHttpException extends HttpException {}

export class CommerceAdmissionException extends CommerceAdmissionHttpException {
  constructor(reason: CommerceAdmissionDenialReason) {
    const status = reason === 'INSUFFICIENT_AVAILABLE_CREDIT' ? 402 : 503
    const error = status === 402 ? 'Payment Required' : 'Service Unavailable'
    super({ statusCode: status, message: reason, error }, status)
  }
}

export class CommerceAdmissionUpstreamException extends CommerceAdmissionHttpException {
  constructor(kind: 'contract' | 'unavailable') {
    const unavailable = kind === 'unavailable'
    const status = unavailable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY
    super(
      {
        statusCode: status,
        message: unavailable
          ? 'Commerce admission service is unavailable'
          : 'Commerce admission upstream contract failed',
        error: unavailable ? 'Service Unavailable' : 'Bad Gateway',
        code: unavailable ? 'COMMERCE_ADMISSION_UNAVAILABLE' : 'COMMERCE_ADMISSION_UPSTREAM_ERROR',
      },
      status,
    )
  }
}

type AdmissionPostOutcome =
  | { kind: 'response'; data: unknown }
  | { kind: 'server-error'; error: unknown }
  | { kind: 'http-error'; status: number; error: unknown; ambiguous: boolean }
  | { kind: 'transport-error'; error: unknown }
  | { kind: 'client-error'; error: unknown; ambiguous: boolean }

@Injectable()
export class CommerceAdmissionService {
  private readonly logger = new Logger(CommerceAdmissionService.name)

  constructor(private readonly config: TypedConfigService) {}

  async admit({
    scenario,
    organizationId,
    resources,
  }: CommerceAdmissionRequest): Promise<CommerceAdmissionReservation | null> {
    const settings = this.config.get('commerceAdmission')
    if (!settings.enabled) return null
    const requestId = randomUUID()
    const startedAt = Date.now()
    const reservation = { organizationId, reservationId: requestId }
    const outcome = await this.postWithRetry(
      `${settings.url}/internal/admission`,
      { requestId, scenario, organizationId, resources },
      settings.token,
      settings.timeoutMs,
    )

    if (outcome.kind === 'server-error') {
      this.warnFailOpen('returned HTTP 5xx', scenario, organizationId, startedAt, outcome.error)
      // The server may have committed the reservation before producing the
      // error. Returning the same handle lets the caller release that
      // uncertainty if its own state change fails; releasing a missing
      // reservation is idempotent.
      return reservation
    }
    if (outcome.kind === 'transport-error') {
      this.scheduleRelease(reservation)
      this.warnBlocked('did not return a response', scenario, organizationId, startedAt, outcome.error)
      throw new CommerceAdmissionUpstreamException('unavailable')
    }
    if (outcome.kind === 'http-error' || outcome.kind === 'client-error') {
      if (outcome.ambiguous) this.scheduleRelease(reservation)
      this.warnBlocked('request failed its upstream contract', scenario, organizationId, startedAt, outcome.error)
      throw new CommerceAdmissionUpstreamException('contract')
    }

    const decision = parseDecision(outcome.data, requestId)
    if (!decision) {
      this.scheduleRelease(reservation)
      this.warnBlocked('response was malformed', scenario, organizationId, startedAt)
      throw new CommerceAdmissionUpstreamException('contract')
    }
    if (decision.admission === false) {
      throw new CommerceAdmissionException(decision.reason)
    }
    return reservation
  }

  async release(reservation: CommerceAdmissionReservation): Promise<void> {
    const settings = this.config.get('commerceAdmission')
    if (!settings.enabled) return
    const startedAt = Date.now()
    const outcome = await this.postWithRetry(
      `${settings.url}/internal/admission/release`,
      reservation,
      settings.token,
      settings.timeoutMs,
    )
    if (outcome.kind !== 'response') {
      this.logger.warn(
        `Commerce admission release failed for ${reservation.organizationId} after ${Date.now() - startedAt}ms: ${describe(outcome.error)}`,
      )
    }
  }

  private async postWithRetry(
    url: string,
    body: unknown,
    token: string,
    totalTimeoutMs: number,
  ): Promise<AdmissionPostOutcome> {
    const deadline = Date.now() + totalTimeoutMs
    let ambiguous = false

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const attemptsRemaining = MAX_ATTEMPTS - attempt + 1
      const remainingMs = Math.max(1, deadline - Date.now())
      const timeout = Math.max(1, Math.floor(remainingMs / attemptsRemaining))
      try {
        const response = await axios.post(url, body, {
          timeout,
          maxRedirects: 0,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
        })
        const status = response.status ?? HttpStatus.OK
        if (status >= 200 && status < 300) return { kind: 'response', data: response.data }
        if (status >= 500 && status < 600) {
          ambiguous = true
          if (attempt < MAX_ATTEMPTS && Date.now() < deadline) continue
          return { kind: 'server-error', error: new Error(`HTTP ${status}`) }
        }
        return { kind: 'http-error', status, error: new Error(`HTTP ${status}`), ambiguous }
      } catch (error) {
        if (!axios.isAxiosError(error)) return { kind: 'client-error', error, ambiguous: true }
        const status = error.response?.status
        if (status !== undefined) {
          if (status >= 500 && status < 600) {
            ambiguous = true
            if (attempt < MAX_ATTEMPTS && Date.now() < deadline) continue
            return { kind: 'server-error', error }
          }
          return { kind: 'http-error', status, error, ambiguous }
        }
        ambiguous = true
        if (attempt < MAX_ATTEMPTS && Date.now() < deadline) continue
        return { kind: 'transport-error', error }
      }
    }

    return { kind: 'transport-error', error: new Error('Commerce admission exhausted its request budget') }
  }

  private scheduleRelease(reservation: CommerceAdmissionReservation): void {
    queueMicrotask(() => {
      void this.release(reservation).catch((error) => {
        this.logger.warn(`Commerce admission cleanup failed for ${reservation.organizationId}: ${describe(error)}`)
      })
    })
  }

  private warnFailOpen(
    operation: string,
    scenario: CommerceAdmissionScenario,
    organizationId: string,
    startedAt: number,
    error?: unknown,
  ): void {
    const detail = error === undefined ? '' : `: ${describe(error)}`
    this.logger.warn(
      `Commerce admission ${operation} for ${organizationId} after ${Date.now() - startedAt}ms; allowing ${scenario}${detail}`,
    )
  }

  private warnBlocked(
    operation: string,
    scenario: CommerceAdmissionScenario,
    organizationId: string,
    startedAt: number,
    error?: unknown,
  ): void {
    const detail = error === undefined ? '' : `: ${describe(error)}`
    this.logger.warn(
      `Commerce admission ${operation} for ${organizationId} after ${Date.now() - startedAt}ms; blocking ${scenario}${detail}`,
    )
  }
}

function parseDecision(raw: unknown, expectedReservationId: string): AdmissionDecision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (
    typeof value.admission !== 'boolean' ||
    typeof value.reason !== 'string' ||
    typeof value.requiredCreditCents !== 'string' ||
    !/^\d+$/.test(value.requiredCreditCents) ||
    typeof value.effectiveAvailableCreditCents !== 'string' ||
    !/^-?\d+$/.test(value.effectiveAvailableCreditCents)
  ) {
    return null
  }
  if (value.admission) {
    if (
      value.reason !== 'SUFFICIENT_AVAILABLE_CREDIT' ||
      !isUuid(value.reservationId) ||
      value.reservationId.toLowerCase() !== expectedReservationId.toLowerCase()
    )
      return null
  } else if (!['INSUFFICIENT_AVAILABLE_CREDIT', 'STALE_USAGE_SNAPSHOT'].includes(value.reason)) {
    return null
  }
  return value as unknown as AdmissionDecision
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function describe(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return `${error.code ?? 'HTTP'} ${error.response?.status ?? ''} ${error.message}`.trim()
  }
  return message(error)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
