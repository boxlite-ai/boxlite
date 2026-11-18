import { BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common'
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

/** A bounded, revision-required control channel; a transport error has an unknown application outcome. */
export class RunnerOutboundControl implements OutboundControl {
  private readonly url: string

  constructor(
    private readonly runner: Runner,
    boxId: string,
  ) {
    const endpoint = runner.apiUrl || runner.proxyUrl
    if (!endpoint) throw new ServiceUnavailableException('Runner has no control endpoint')
    this.url = `${endpoint.replace(/\/$/, '')}/v1/boxes/${encodeURIComponent(boxId)}/network/outbound`
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

  private checkResponse(response: Response, body: unknown): void {
    if (response.status === 200) return
    const code = record(body) && record(body.error) ? body.error.code : undefined
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
