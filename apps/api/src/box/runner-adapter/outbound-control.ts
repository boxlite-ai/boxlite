import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import type { CreateBoxDTO, RecoverBoxDTO } from '@boxlite-ai/runner-api-client'
import { Runner } from '../entities/runner.entity'
import { validateNetworkAllowList } from '../utils/network-validation.util'
import { OutboundPolicy } from './network-policy'

export type OutboundSnapshot = { revision: string; policy: OutboundPolicy }
export type OutboundPhase = 'pending' | 'confirmed' | 'uncertain'
export type OutboundStatus = {
  persisted: OutboundSnapshot
  observed: (OutboundSnapshot & { application_state: OutboundPhase }) | null
  application_state: OutboundPhase
  pending_revision?: string
}

export type CompleteOutboundPolicy = OutboundPolicy & { deny_net?: string[] }
export type CompleteOutboundSnapshot = {
  revision: string
  admission: 'legacy' | 'extended_ipv4'
  policy: OutboundPolicy & { deny_net: string[] }
}
export type PreparedOutboundCreate = { snapshot: CompleteOutboundSnapshot; deny_present: boolean }

export type HostedOutboundAttempt = {
  incarnation: string
  attempt_id: string
  generation: number
  previous: CompleteOutboundSnapshot
  candidate: PreparedOutboundCreate
}

export type HostedOutboundCommand =
  | { operation: 'prepare'; previous: CompleteOutboundSnapshot; revision: string; policy: CompleteOutboundPolicy }
  | { operation: 'apply' | 'cancel' | 'reconcile' | 'finalize'; attempt: HostedOutboundAttempt }
  | { operation: 'restore'; attempt: HostedOutboundAttempt; revision: string }

export type HostedOutboundReceipt =
  | { outcome: 'prepared'; candidate: PreparedOutboundCreate }
  | { outcome: 'pending' | 'cancelled' }
  | { outcome: 'applied' | 'restored' | 'finalized'; snapshot: CompleteOutboundSnapshot }

export type CompleteCreateAttempt = {
  incarnation: string
  attempt_id: string
  generation: number
  prepared: PreparedOutboundCreate
  job_id?: string
  claim_id?: string
}

export type CompleteCreateBox = Omit<CreateBoxDTO, 'outboundEnabled' | 'outboundAllowNet' | 'skipStart'>

export type CompleteCreateOutcome =
  | { outcome: 'pending' }
  | { outcome: 'installed'; snapshot: CompleteOutboundSnapshot }
  | { outcome: 'no_effect'; failure?: 'unsupported' }
export type CompleteOutboundStatus = {
  persisted: CompleteOutboundSnapshot
  observed: { snapshot: CompleteOutboundSnapshot; application_state: OutboundPhase } | null
  application_state: OutboundPhase
  pending_revision?: string
  observation_error?: string
}

export interface OutboundControl {
  status(): Promise<OutboundStatus>
  replace(expected: string, candidate: OutboundSnapshot): Promise<'applied' | 'precondition_failed'>
}

export function validOutboundRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function sameOutboundSnapshot(left: OutboundSnapshot, right: OutboundSnapshot): boolean {
  return left.revision === right.revision && samePolicy(left.policy, right.policy)
}

export function sameCompleteOutboundSnapshot(left: CompleteOutboundSnapshot, right: CompleteOutboundSnapshot): boolean {
  return (
    left.revision === right.revision &&
    left.admission === right.admission &&
    samePolicy(left.policy, right.policy) &&
    left.policy.deny_net.length === right.policy.deny_net.length &&
    left.policy.deny_net.every((rule, index) => rule === right.policy.deny_net[index])
  )
}

function samePolicy(left: OutboundPolicy, right: OutboundPolicy): boolean {
  return (
    left.mode === right.mode &&
    left.allow_net.length === right.allow_net.length &&
    left.allow_net.every((rule, index) => rule === right.allow_net[index])
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function policy(value: unknown): value is OutboundPolicy {
  if (!record(value) || Object.keys(value).some((key) => !['mode', 'allow_net'].includes(key))) return false
  if (!['enabled', 'disabled'].includes(value.mode as string) || !Array.isArray(value.allow_net)) return false
  if (value.allow_net.some((rule) => typeof rule !== 'string' || !rule || rule !== rule.trim())) return false
  if (value.mode === 'disabled' && value.allow_net.length) return false
  try {
    validateNetworkAllowList(value.allow_net)
    return true
  } catch {
    return false
  }
}

export function validOutboundSnapshot(value: unknown): value is OutboundSnapshot {
  return record(value) && validOutboundRevision(value.revision) && policy(value.policy)
}

function phase(value: unknown): value is OutboundPhase {
  return ['pending', 'confirmed', 'uncertain'].includes(value as string)
}

function completeRuleList(value: unknown, canonical: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((rule) => typeof rule === 'string' && rule.trim() !== '' && (!canonical || rule === rule.trim()))
  )
}

export function validCompleteOutboundPolicy(value: unknown): value is CompleteOutboundPolicy {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['mode', 'allow_net', 'deny_net'].includes(key)) &&
    (value.mode === 'enabled' || value.mode === 'disabled') &&
    completeRuleList(value.allow_net, false) &&
    (value.mode !== 'disabled' || value.allow_net.length === 0) &&
    (value.deny_net === undefined || completeRuleList(value.deny_net, false))
  )
}

export function validCompleteOutboundSnapshot(value: unknown): value is CompleteOutboundSnapshot {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['revision', 'admission', 'policy'].includes(key)) ||
    !validOutboundRevision(value.revision) ||
    !validCompleteOutboundPolicy(value.policy) ||
    !completeRuleList(value.policy.deny_net, true)
  ) {
    return false
  }
  // Legacy snapshots retain their stored spelling. Runtime canonicalizes extended rules.
  if (value.admission === 'legacy') {
    return value.policy.deny_net.length === 0 && policy({ mode: value.policy.mode, allow_net: value.policy.allow_net })
  }
  return value.admission === 'extended_ipv4' && completeRuleList(value.policy.allow_net, true)
}

export function validPreparedOutboundCreate(value: unknown): value is PreparedOutboundCreate {
  return validPreparedOutbound(value) && value.snapshot.admission === 'extended_ipv4'
}

export function validPreparedOutbound(value: unknown): value is PreparedOutboundCreate {
  return (
    record(value) &&
    typeof value.deny_present === 'boolean' &&
    validCompleteOutboundSnapshot(value.snapshot) &&
    value.snapshot.revision !== 'initial' &&
    (value.deny_present || value.snapshot.policy.deny_net.length === 0)
  )
}

export function validCompleteCreateAttempt(value: unknown): value is CompleteCreateAttempt {
  return (
    record(value) &&
    validOutboundRevision(value.incarnation) &&
    validOutboundRevision(value.attempt_id) &&
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    ((value.job_id === undefined && value.claim_id === undefined) ||
      (validOutboundRevision(value.job_id) && validOutboundRevision(value.claim_id))) &&
    validPreparedOutboundCreate(value.prepared)
  )
}

function sameCreateAttempt(left: CompleteCreateAttempt, right: CompleteCreateAttempt): boolean {
  return (
    left.incarnation === right.incarnation &&
    left.attempt_id === right.attempt_id &&
    left.generation === right.generation &&
    left.job_id === right.job_id &&
    left.claim_id === right.claim_id &&
    left.prepared.deny_present === right.prepared.deny_present &&
    sameCompleteOutboundSnapshot(left.prepared.snapshot, right.prepared.snapshot)
  )
}

export function decodeCompleteCreateOutcome(body: unknown, attempt: CompleteCreateAttempt): CompleteCreateOutcome {
  if (!record(body) || !validCompleteCreateAttempt(body.attempt) || !sameCreateAttempt(attempt, body.attempt)) {
    throw new ServiceUnavailableException('Runner did not return proof for the exact complete create attempt')
  }
  switch (body.outcome) {
    case 'installed':
      if (
        body.failure === undefined &&
        validCompleteOutboundSnapshot(body.snapshot) &&
        sameCompleteOutboundSnapshot(attempt.prepared.snapshot, body.snapshot)
      ) {
        return { outcome: 'installed', snapshot: body.snapshot }
      }
      break
    case 'no_effect':
      if (body.snapshot === undefined && (body.failure === undefined || body.failure === 'unsupported')) {
        return body.failure === 'unsupported'
          ? { outcome: 'no_effect', failure: 'unsupported' }
          : { outcome: 'no_effect' }
      }
      break
    case 'pending':
      if (body.snapshot === undefined && body.failure === undefined) return { outcome: 'pending' }
      break
  }
  throw new ServiceUnavailableException('Runner returned inconsistent complete create proof')
}

export function runnerOutboundEndpoint(runner: Runner): string | undefined {
  return (runner.apiUrl || runner.proxyUrl)?.replace(/\/$/, '')
}

/** A bounded, revision-required control channel; a transport error has an unknown application outcome. */
export class RunnerOutboundControl implements OutboundControl {
  private readonly url: string

  constructor(
    private readonly runner: Runner,
    private readonly boxId: string,
  ) {
    const endpoint = runnerOutboundEndpoint(runner)
    if (!endpoint) throw new ServiceUnavailableException('Runner has no control endpoint')
    this.url = `${endpoint}/v1/boxes/${encodeURIComponent(boxId)}/network/outbound`
  }

  async createComplete(attempt: CompleteCreateAttempt, box: CompleteCreateBox): Promise<CompleteCreateOutcome> {
    if (box.id !== this.boxId) throw new BadRequestException('Complete create target differs from its control URL')
    return this.completeCreateRequest('/complete/create', attempt, { attempt, box })
  }

  async cancelCompleteCreate(attempt: CompleteCreateAttempt): Promise<CompleteCreateOutcome> {
    return this.completeCreateRequest('/complete/cancel-create', attempt, attempt)
  }

  async rebuild(
    snapshot: CompleteOutboundSnapshot,
    stamp: number,
    box: Omit<RecoverBoxDTO, 'outboundEnabled' | 'outboundAllowNet'>,
  ): Promise<void> {
    const { response, body } = await this.request('/complete/rebuild', 'POST', {
      body: JSON.stringify({ snapshot, stamp, box }),
    })
    this.checkResponse(response, body, true)
    if (!validCompleteOutboundSnapshot(body) || !sameCompleteOutboundSnapshot(snapshot, body)) {
      throw new ServiceUnavailableException('Runner did not confirm the complete rebuild snapshot')
    }
  }

  async hostedOutbound(command: HostedOutboundCommand): Promise<HostedOutboundReceipt> {
    const { response, body } = await this.request('/complete/replace-control', 'POST', {
      body: JSON.stringify(command),
    })
    this.checkResponse(response, body, true)
    if (record(body)) {
      switch (body.outcome) {
        case 'prepared':
          if (
            command.operation === 'prepare' &&
            validPreparedOutbound(body.candidate) &&
            body.candidate.snapshot.revision === command.revision &&
            body.candidate.deny_present === (command.policy.deny_net !== undefined) &&
            body.candidate.snapshot.policy.mode === command.policy.mode &&
            body.candidate.snapshot.policy.allow_net.length === command.policy.allow_net.length &&
            body.candidate.snapshot.policy.deny_net.length === (command.policy.deny_net?.length ?? 0)
          ) {
            return { outcome: 'prepared', candidate: body.candidate }
          }
          break
        case 'pending':
        case 'cancelled':
          if (command.operation !== 'prepare') return { outcome: body.outcome }
          break
        case 'applied':
        case 'restored':
        case 'finalized':
          if (command.operation !== 'prepare' && validCompleteOutboundSnapshot(body.snapshot)) {
            return { outcome: body.outcome, snapshot: body.snapshot }
          }
      }
    }
    throw new ServiceUnavailableException('Runner returned invalid hosted outbound receipt')
  }

  private async completeCreateRequest(
    path: '/complete/create' | '/complete/cancel-create',
    attempt: CompleteCreateAttempt,
    payload: unknown,
  ): Promise<CompleteCreateOutcome> {
    if (!validCompleteCreateAttempt(attempt)) throw new BadRequestException('Invalid complete create attempt')
    const { response, body } = await this.request(path, 'POST', { body: JSON.stringify(payload) })
    this.checkResponse(response, body, true)
    return decodeCompleteCreateOutcome(body, attempt)
  }

  async prepareCreate(revision: string, request: CompleteOutboundPolicy): Promise<PreparedOutboundCreate> {
    if (!validOutboundRevision(revision) || revision === 'initial' || !validCompleteOutboundPolicy(request)) {
      throw new BadRequestException('A valid revision and complete outbound create policy are required')
    }
    const { response, body } = await this.request('/complete/prepare-create', 'POST', {
      headers: { 'X-Boxlite-Outbound-Revision': revision },
      body: JSON.stringify(request),
    })
    this.checkResponse(response, body, true)
    if (
      !record(body) ||
      !validCompleteOutboundSnapshot(body.snapshot) ||
      body.deny_present !== (request.deny_net !== undefined) ||
      body.snapshot.revision !== revision ||
      body.snapshot.admission !== 'extended_ipv4' ||
      body.snapshot.policy.mode !== request.mode ||
      body.snapshot.policy.allow_net.length !== request.allow_net.length ||
      body.snapshot.policy.deny_net.length !== (request.deny_net?.length ?? 0)
    ) {
      throw new ServiceUnavailableException('Runner returned invalid prepared outbound create identity')
    }
    return { snapshot: body.snapshot, deny_present: body.deny_present }
  }

  async completeSnapshot(): Promise<CompleteOutboundSnapshot> {
    const { response, body } = await this.request('/complete', 'GET')
    this.checkResponse(response, body, true)
    if (!validCompleteOutboundSnapshot(body) || response.headers.get('etag') !== `"${body.revision}"`) {
      throw new ServiceUnavailableException('Runner returned invalid complete outbound snapshot')
    }
    return body
  }

  async completeStatus(): Promise<CompleteOutboundStatus> {
    const { response, body } = await this.request('/complete/status', 'GET')
    this.checkResponse(response, body, true)
    if (
      !record(body) ||
      !validCompleteOutboundSnapshot(body.persisted) ||
      !phase(body.application_state) ||
      (body.pending_revision !== undefined && !validOutboundRevision(body.pending_revision)) ||
      (body.observation_error !== undefined && typeof body.observation_error !== 'string') ||
      (body.observed !== null &&
        (!record(body.observed) ||
          !phase(body.observed.application_state) ||
          !validCompleteOutboundSnapshot(body.observed.snapshot)))
    ) {
      throw new ServiceUnavailableException('Runner returned invalid complete outbound status')
    }
    const result = body as CompleteOutboundStatus
    if (
      result.application_state === 'confirmed' &&
      (!result.observed ||
        result.pending_revision !== undefined ||
        result.observation_error !== undefined ||
        result.observed.application_state !== 'confirmed' ||
        !sameCompleteOutboundSnapshot(result.persisted, result.observed.snapshot))
    ) {
      throw new ServiceUnavailableException('Runner returned inconsistent confirmed complete outbound status')
    }
    return result
  }

  async status(): Promise<OutboundStatus> {
    const { response, body } = await this.request('/status', 'GET')
    this.checkResponse(response, body)
    if (!record(body) || !Array.isArray(body.capabilities) || !body.capabilities.includes('revision-v1')) {
      throw new ServiceUnavailableException('Runner lacks revision-v1 outbound status')
    }
    if (
      !validOutboundSnapshot(body.persisted) ||
      !phase(body.application_state) ||
      (body.pending_revision !== undefined && !validOutboundRevision(body.pending_revision)) ||
      (body.observed !== null &&
        (!record(body.observed) || !phase(body.observed.application_state) || !validOutboundSnapshot(body.observed)))
    ) {
      throw new ServiceUnavailableException('Runner returned invalid outbound status')
    }
    const result = body as unknown as OutboundStatus
    // A matching live identity is insufficient while Runtime still owns unfinished persistence.
    if (
      result.application_state === 'confirmed' &&
      (!result.observed ||
        result.pending_revision !== undefined ||
        result.observed.application_state !== 'confirmed' ||
        !sameOutboundSnapshot(result.persisted, result.observed) ||
        body.observation_error !== undefined)
    ) {
      throw new ServiceUnavailableException('Runner returned inconsistent confirmed outbound status')
    }
    return result
  }

  async replace(expected: string, candidate: OutboundSnapshot): Promise<'applied' | 'precondition_failed'> {
    if (
      !validOutboundRevision(expected) ||
      !validOutboundSnapshot(candidate) ||
      candidate.revision === expected ||
      candidate.revision === 'initial'
    ) {
      throw new BadRequestException('A valid expected revision and fresh outbound candidate are required')
    }
    const { response, body } = await this.request('/snapshot', 'PUT', {
      headers: { 'If-Match': `"${expected}"`, 'X-Boxlite-Outbound-Revision': candidate.revision },
      body: JSON.stringify(candidate.policy),
    })
    if (response.status === 412) return 'precondition_failed'
    this.checkResponse(response, body)
    if (
      response.headers.get('etag') !== `"${candidate.revision}"` ||
      !policy(body) ||
      !samePolicy(body, candidate.policy)
    ) {
      throw new ServiceUnavailableException('Runner did not acknowledge the exact outbound candidate')
    }
    return 'applied'
  }

  private checkResponse(response: Response, body: unknown, complete = false): void {
    if (response.status === 200) return
    const code = record(body) && record(body.error) ? body.error.code : undefined
    if (complete && (code === 'unsupported' || (!code && [404, 405, 501].includes(response.status)))) {
      throw new HttpException(
        { message: 'Runner does not support complete outbound control', code: 'unsupported' },
        501,
      )
    }
    if ([404, 405, 501].includes(response.status) && !code) {
      throw new HttpException(
        { message: 'Runner does not support revisioned outbound control', code: 'unsupported' },
        400,
      )
    }
    if (['invalid_argument', 'invalid_state', 'unsupported', 'not_found'].includes(code as string)) {
      throw new HttpException(
        { message: 'Runner refused revisioned outbound control', code },
        response.status >= 400 ? response.status : 503,
      )
    }
    throw new ServiceUnavailableException('Runner did not confirm revisioned outbound control')
  }

  private async request(path: string, method: string, init: { headers?: Record<string, string>; body?: string } = {}) {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(this.url + path, {
        method,
        headers: { Authorization: `Bearer ${this.runner.apiKey}`, 'Content-Type': 'application/json', ...init.headers },
        body: init.body,
        redirect: 'error',
        signal: controller.signal,
      })
      // Refusal is complete at the headers; an error page must not turn it into an uncertain body timeout.
      if (response.status === 412) {
        await response.body?.cancel()
        return { response, body: null }
      }
      const reader = response.body?.getReader()
      const cancelBody = () => {
        void reader?.cancel().catch(() => undefined)
      }
      controller.signal.addEventListener('abort', cancelBody, { once: true })
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        if (reader)
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.length
            if (size > 65536) throw new Error('Outbound control response too large')
            chunks.push(value)
          }
      } finally {
        controller.signal.removeEventListener('abort', cancelBody)
        await reader?.cancel().catch(() => undefined)
        reader?.releaseLock()
      }
      controller.signal.throwIfAborted()
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try {
        body = JSON.parse(text)
      } catch {
        /* Untyped failures retain their HTTP classification. */
      }
      return { response, body }
    } catch {
      // Endpoint URLs, credentials, and upstream diagnostics stay out of public errors.
      throw new ServiceUnavailableException('Outbound control was not acknowledged; application is uncertain')
    } finally {
      clearTimeout(deadline)
    }
  }
}
