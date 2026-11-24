/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { PollMessageError, ScaleSetPollError } from './scale-set-poll-error'
import { githubErrorMessage, githubErrorRetryAt, GitHubRequestError, readGitHubBody } from './github'
import { object, positive } from './execution/model'
import { JitRegistration, RunnerEffect, RunnerIdentity } from './runners'

const sets = '_apis/runtime/runnerscalesets'
const agents = '_apis/distributedtask/pools/0/agents'
const exchange = 'https://api.github.com/actions/runner-registration'
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const invalid = (): never => {
  throw new Error('Invalid GitHub Actions service response')
}
const serviceUrl = (raw: unknown): URL => {
  if (typeof raw !== 'string') return invalid()
  const url = new URL(raw)
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname.endsWith('.actions.githubusercontent.com')
  )
    return invalid()
  return url
}
const secret = (value: unknown): string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,32768}$/.test(value) ? value : invalid()

// GitHub transmits signed int64 JSON numbers; the journal stores their canonical decimal digits.
type RequestId = number | string
export function isRequestIdText(text: unknown): text is string {
  if (typeof text !== 'string' || !/^(?:0|-?[1-9]\d{0,18})$/.test(text)) return false
  const id = BigInt(text)
  return id >= -9_223_372_036_854_775_808n && id <= 9_223_372_036_854_775_807n
}
class WireRequestId {
  constructor(
    readonly value: number,
    readonly source: string,
  ) {}
}
function decode(text: string, acquisition = false): unknown {
  return JSON.parse(text, function (this: unknown, key, value: unknown, context?: { source: string }) {
    // Capture numeric tokens before they are confused with quoted strings or rounded Numbers.
    if (typeof value === 'number' && (key === 'runnerRequestId' || (acquisition && Array.isArray(this))))
      return new WireRequestId(value, context?.source ?? '')
    return value
  })
}
function readRequestId(token: unknown): RequestId {
  if (token instanceof WireRequestId) {
    if (token.source === '-0') return 0
    if (isRequestIdText(token.source)) return Number.isSafeInteger(token.value) ? token.value : token.source
  }
  throw new PollMessageError('job-request-id', token instanceof WireRequestId ? token.value : token)
}
function requestIdText(id: RequestId): string {
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id)
  return isRequestIdText(id) ? id : invalid()
}
interface Call {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: string
  headers?: Record<string, string>
  poll?: boolean
  acquisition?: boolean
  signal?: AbortSignal
}
function pollMessage(raw: unknown): SetMessage {
  if (!object(raw) || !natural(raw.messageId))
    throw new PollMessageError('message-id', object(raw) ? raw.messageId : raw)
  if (raw.messageType !== 'RunnerScaleSetJobMessages') throw new PollMessageError('message-type', raw.messageType)
  if (raw.body !== undefined && typeof raw.body !== 'string') throw new PollMessageError('message-body', raw.body)
  let events: unknown
  try {
    events = typeof raw.body === 'string' && raw.body ? decode(raw.body) : []
  } catch {
    throw new PollMessageError('message-body', raw.body)
  }
  if (!Array.isArray(events)) throw new PollMessageError('message-body', events)
  const available: SetMessage['available'] = []
  const worked: RunnerIdentity[] = []
  const settledRequests: RequestId[] = []
  for (const event of events) {
    if (!object(event) || typeof event.messageType !== 'string')
      throw new PollMessageError('event-type', object(event) ? event.messageType : event)
    if (['JobAssigned', 'JobStarted', 'JobCompleted'].includes(event.messageType) && event.runnerRequestId != null)
      settledRequests.push(readRequestId(event.runnerRequestId))
    if (event.messageType === 'JobStarted' || event.messageType === 'JobCompleted') {
      if (
        positive(event.runnerId) &&
        typeof event.runnerName === 'string' &&
        /^ci-jit-[a-f0-9]{32}$/.test(event.runnerName)
      )
        worked.push({ id: event.runnerId, name: event.runnerName })
      continue
    }
    if (event.messageType !== 'JobAvailable') continue
    if (
      typeof event.ownerName !== 'string' ||
      typeof event.repositoryName !== 'string' ||
      !Array.isArray(event.requestLabels) ||
      !event.requestLabels.every((label) => typeof label === 'string')
    )
      throw new PollMessageError('job-available', event.requestLabels)
    available.push({
      id: readRequestId(event.runnerRequestId),
      owner: event.ownerName,
      repository: event.repositoryName,
      labels: event.requestLabels,
    })
  }
  if (raw.statistics != null && (!object(raw.statistics) || !natural(raw.statistics.totalAssignedJobs)))
    throw new PollMessageError('statistics', object(raw.statistics) ? raw.statistics.totalAssignedJobs : raw.statistics)
  return {
    id: raw.messageId,
    assigned: raw.statistics == null ? undefined : assigned(raw.statistics),
    available,
    worked,
    settledRequests,
  }
}
function request(url: URL, authorization: string, call: Call & { poll: true }): Promise<SetMessage | null>
function request(url: URL, authorization: string, call?: Call): Promise<unknown>
async function request(url: URL, authorization: string, call: Call = {}): Promise<unknown> {
  const method = call.method ?? 'GET'
  const deadline = AbortSignal.timeout(call.poll ? 120_000 : 15_000)
  const signal = call.signal ? AbortSignal.any([deadline, call.signal]) : deadline
  let response: Response | undefined
  let readingBody = false
  let decoding = false
  try {
    signal.throwIfAborted()
    response = await fetch(url.toString(), {
      method,
      signal,
      redirect: call.poll ? 'manual' : 'error',
      body: call.body,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authorization,
        'User-Agent': 'boxlite-ci-listener',
        ...call.headers,
      },
    })
    const status = response.status
    if (!response.ok || status === 204 || (call.poll && status === 202)) {
      if (call.poll && status !== 202)
        throw new ScaleSetPollError('http', response, undefined, await githubErrorMessage(response))
      const retryAt = !response.ok ? await githubErrorRetryAt(response) : undefined
      await response.body?.cancel()
      if (status === 204 && method === 'DELETE') return undefined
      if (status === 202 && call.poll) return null
      throw new GitHubRequestError(status, method !== 'GET' && status >= 500, retryAt, retryAt !== undefined)
    }
    if (method === 'DELETE') {
      await response.body?.cancel()
      throw new GitHubRequestError(status, true)
    }
    readingBody = true
    const body = await readGitHubBody(response)
    decoding = true
    const raw = decode(body, call.acquisition)
    return call.poll ? pollMessage(raw) : raw
  } catch (error) {
    if (method === 'GET' && call.signal?.aborted) throw call.signal.reason
    if (error instanceof GitHubRequestError) throw error
    if (call.poll) {
      const reason =
        error instanceof PollMessageError
          ? error.field
          : deadline.aborted
            ? 'timeout'
            : decoding
              ? 'response-json'
              : readingBody
                ? 'response-read'
                : 'transport'
      throw new ScaleSetPollError(reason, response, error)
    }
    throw new GitHubRequestError(response?.status, method !== 'GET')
  }
}
function list(value: unknown): unknown[] {
  if (!object(value) || !Array.isArray(value.value) || value.value.length !== value.count) return invalid()
  return value.value
}
function one(value: unknown): unknown {
  const items = list(value)
  if (items.length > 1) return invalid()
  return items[0]
}
function assigned(value: unknown): number {
  if (!object(value) || !natural(value.totalAssignedJobs)) return invalid()
  return value.totalAssignedJobs
}
function statistics(value: unknown) {
  if (!object(value)) return invalid()
  const count = assigned(value)
  const acquired = value.totalAcquiredJobs
  if (acquired === undefined) return { assigned: count, acquired: undefined }
  if (!natural(acquired)) return invalid()
  return { assigned: count, acquired }
}
interface Admin {
  url: URL
  token: string
  expires: number
}
export class ScaleSetRemoved extends Error {}
export interface SetIdentity {
  id: number
  name: string
  group: number
}
export interface SetMessage {
  id: number
  assigned?: number
  worked: RunnerIdentity[]
  settledRequests: RequestId[]
  available: { id: RequestId; owner: string; repository: string; labels: string[] }[]
}

/** Admin credentials are scoped to one GitHub configuration URL and shared by its session and JIT requests. */
export class ActionsScaleSets {
  private admin?: Admin
  private refreshing?: Promise<Admin>
  private registrationAttempt?: { token: string; expires: number; attempts: number; retry?: GitHubRequestError }
  constructor(
    private readonly scope: string,
    private readonly registration: (signal?: AbortSignal) => Promise<string>,
  ) {
    if (
      !/^https:\/\/github\.com\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9_.-]+)?$/.test(scope) ||
      new URL(scope).toString() !== scope
    )
      throw new Error('Invalid GitHub scale set scope')
  }
  private async connect(signal?: AbortSignal): Promise<Admin> {
    let attempt = this.registrationAttempt
    if (attempt?.retry?.retryAt && attempt.retry.retryAt > Date.now()) throw attempt.retry
    if (!attempt || attempt.expires <= Date.now()) {
      attempt = { token: secret(await this.registration(signal)), expires: Date.now() + 5 * 60_000, attempts: 0 }
      this.registrationAttempt = attempt
    }
    let response: unknown
    try {
      response = await request(new URL(exchange), 'RemoteAuth ' + attempt.token, {
        method: 'POST',
        body: JSON.stringify({ url: this.scope, runner_event: 'register' }),
        signal,
      })
    } catch (error) {
      // The token may need to propagate. Return the deadline to the supervisor
      // so other scopes can use its permit during the wait.
      if (
        error instanceof GitHubRequestError &&
        (error.status === 401 || error.status === 403) &&
        attempt.attempts < 4
      ) {
        const retryAt = error.retryAt ?? Date.now() + 1000 * 2 ** attempt.attempts
        attempt.attempts++
        attempt.retry = new GitHubRequestError(error.status, false, retryAt, error.rateLimited)
        throw attempt.retry
      }
      this.registrationAttempt = undefined
      throw error
    }
    this.registrationAttempt = undefined
    if (!object(response)) return invalid()
    const admin = secret(response.token)
    const claims = decode(Buffer.from(admin.split('.')[1] ?? '', 'base64url').toString('utf8'))
    if (!object(claims) || !positive(claims.exp) || claims.exp * 1000 <= Date.now()) return invalid()
    const url = serviceUrl(response.url)
    if (url.search) return invalid()
    return (this.admin = { url, token: admin, expires: claims.exp * 1000 })
  }
  private async connection(signal?: AbortSignal) {
    if (this.admin && this.admin.expires > Date.now() + 60_000) return this.admin
    return (this.refreshing ??= this.connect(signal).finally(() => {
      this.refreshing = undefined
    }))
  }
  async service(path: string, call: Call, query?: URLSearchParams, sessionToken?: string): Promise<unknown> {
    if (!/^_apis\/[a-zA-Z0-9/-]+$/.test(path)) throw new Error('Invalid Actions service path')
    const admin = await this.connection(call.signal)
    const url = new URL(admin.url)
    url.pathname = url.pathname.replace(/\/$/, '') + '/' + path
    url.search = query?.toString() ?? ''
    url.searchParams.set('api-version', '6.0-preview')
    try {
      return await request(url, 'Bearer ' + (sessionToken ?? admin.token), call)
    } catch (error) {
      if (!sessionToken && error instanceof GitHubRequestError && error.status === 401 && this.admin === admin)
        this.admin = undefined
      throw error
    }
  }
  async resolve(
    name: string,
    group: number,
    labels: readonly string[],
    signal?: AbortSignal,
    original?: number,
  ): Promise<SetIdentity> {
    if (!/^[a-z0-9-]{1,128}$/.test(name) || !positive(group) || !labels.length) return invalid()
    const query = new URLSearchParams({ name, runnerGroupId: String(group) })
    let found: unknown
    if (original !== undefined) {
      if (!positive(original)) return invalid()
      try {
        found = await this.service(sets + '/' + original, { signal })
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404)
          throw new ScaleSetRemoved('Managed scale set was removed')
        throw error
      }
    } else found = one(await this.service(sets, { signal }, query))
    if (found === undefined) {
      found = await this.service(sets, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          name,
          runnerGroupId: group,
          labels: labels.map((name) => ({ name, type: 'System' })),
          runnerSetting: { disableUpdate: true },
        }),
      })
    }
    if (
      !object(found) ||
      !positive(found.id) ||
      (original !== undefined && found.id !== original) ||
      found.name !== name ||
      found.runnerGroupId !== group ||
      !Array.isArray(found.labels) ||
      found.labels.length !== labels.length ||
      !labels.every(
        (label) =>
          Array.isArray(found.labels) &&
          found.labels.some(
            (item) => object(item) && typeof item.name === 'string' && item.name.toLowerCase() === label.toLowerCase(),
          ),
      )
    )
      return invalid()
    return { id: found.id, name, group }
  }
  async currentStatistics(id: number, signal: AbortSignal) {
    const raw = await this.service(sets + '/' + id, { signal })
    if (!object(raw) || raw.id !== id) return invalid()
    return statistics(raw.statistics)
  }
  async open(id: number, owner: string, signal?: AbortSignal): Promise<ScaleSetSession> {
    if (!positive(id) || !owner || owner.length > 128) return invalid()
    const initial = await this.service(sets + '/' + id + '/sessions', {
      method: 'POST',
      body: JSON.stringify({ ownerName: owner }),
      signal,
    })
    return new ScaleSetSession(this, id, initial)
  }
  registry(id: number, before: (effect: RunnerEffect) => Promise<void>) {
    const validateName = (name: string) => {
      if (!positive(id) || !/^ci-jit-[a-f0-9]{32}$/.test(name)) throw new Error('Original JIT runner identity required')
    }
    const identity = (value: unknown, name: string, expected?: number): RunnerIdentity => {
      if (
        !object(value) ||
        value.name !== name ||
        !positive(value.id) ||
        value.runnerScaleSetId !== id ||
        (expected !== undefined && value.id !== expected)
      )
        return invalid()
      return { id: value.id, name }
    }
    const lookup = async (original: { id?: number; name: string }, signal?: AbortSignal) => {
      validateName(original.name)
      const value = one(await this.service(agents, { signal }, new URLSearchParams({ agentName: original.name })))
      return value === undefined ? null : identity(value, original.name, original.id)
    }
    return {
      lookup,
      create: async (name: string, signal?: AbortSignal) => {
        validateName(name)
        await before({ kind: 'register', name })
        const value = await this.service(sets + '/' + id + '/generatejitconfig', {
          method: 'POST',
          body: JSON.stringify({ name, workFolder: '_work' }),
          signal,
        })
        if (!object(value)) return invalid()
        return new JitRegistration(identity(value.runner, name), value.encodedJITConfig)
      },
      remove: async (original: RunnerIdentity, signal?: AbortSignal) => {
        if (!positive(original.id)) return invalid()
        if (!(await lookup(original, signal))) return
        await before({ kind: 'remove', ...original })
        await this.service(agents + '/' + original.id, { method: 'DELETE', signal })
        if (await lookup(original, signal)) throw new Error('Scale set runner deletion pending')
      },
    }
  }
}

function sessionData(value: unknown, setId: number) {
  if (
    !object(value) ||
    typeof value.sessionId !== 'string' ||
    !uuid.test(value.sessionId) ||
    (value.runnerScaleSet != null && (!object(value.runnerScaleSet) || value.runnerScaleSet.id !== setId))
  )
    return invalid()
  return {
    id: value.sessionId,
    queue: serviceUrl(value.messageQueueUrl),
    token: secret(value.messageQueueAccessToken),
    statistics: value.statistics == null ? undefined : statistics(value.statistics),
  }
}
export class ScaleSetSession {
  private data: ReturnType<typeof sessionData>
  readonly initial: number
  readonly initialAcquired?: number
  constructor(
    private readonly client: ActionsScaleSets,
    private readonly set: number,
    raw: unknown,
  ) {
    this.data = sessionData(raw, set)
    this.initial = this.data.statistics?.assigned ?? invalid()
    this.initialAcquired = this.data.statistics?.acquired
  }
  get id(): string {
    return this.data.id
  }
  private path() {
    return sets + '/' + this.set + '/sessions/' + this.data.id
  }
  async withToken<T>(call: (refreshed: boolean) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await call(false)
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 401) throw error
      const fresh = sessionData(await this.client.service(this.path(), { method: 'PATCH', signal }), this.set)
      if (fresh.id !== this.data.id) return invalid()
      this.data = fresh
      return call(true)
    }
  }
  async poll(capacity: number, last?: number, signal?: AbortSignal): Promise<SetMessage | null> {
    if (!natural(capacity) || (last !== undefined && !natural(last))) throw new ScaleSetPollError('poll-arguments')
    return this.withToken(() => {
      const url = new URL(this.data.queue)
      if (last !== undefined && last > 0) url.searchParams.set('lastMessageId', String(last))
      return request(url, 'Bearer ' + this.data.token, {
        signal,
        poll: true,
        headers: { Accept: 'application/json; api-version=6.0-preview', 'X-ScaleSetMaxCapacity': String(capacity) },
      })
    }, signal).catch((error: unknown) => {
      if (signal?.aborted || error instanceof ScaleSetPollError) throw error
      throw new ScaleSetPollError('token-refresh', undefined, error)
    })
  }
  async acquire(ids: RequestId[], signal?: AbortSignal): Promise<RequestId[]> {
    const unique = new Set(ids.map(requestIdText))
    if (!unique.size) return []
    const response = await this.client.service(
      sets + '/' + this.set + '/acquirejobs',
      { method: 'POST', body: '[' + [...unique].join(',') + ']', acquisition: true, signal },
      undefined,
      this.data.token,
    )
    const result = list(response).map(readRequestId)
    if (!result.every((id) => unique.delete(String(id)))) return invalid()
    return result
  }
  async ack(id: number, signal?: AbortSignal): Promise<void> {
    if (!natural(id)) return invalid()
    await this.withToken(async () => {
      const url = new URL(this.data.queue)
      url.pathname = url.pathname.replace(/\/$/, '') + '/' + id
      await request(url, 'Bearer ' + this.data.token, { method: 'DELETE', signal })
    }, signal)
  }
  async close(signal?: AbortSignal) {
    await this.client.service(this.path(), { method: 'DELETE', signal })
  }
}
