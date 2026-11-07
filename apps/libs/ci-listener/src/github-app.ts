/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { KeyLike } from 'node:crypto'
import { createGitHubAppJwt, githubRequest, GitHubRequestError } from './github'
import { Json } from './state/database'
import { decodeDeliveryPage, deliveryCursor, deliveryId, GitHubDeliveryPage } from './deliveries'

export interface GitHubInstallation {
  id: number
  account: { id: number; login: string; type: 'User' | 'Organization' }
  permissions: Record<string, string>
  suspended: boolean
}
export type GitHubTokenPurpose =
  | { kind: 'catalog' }
  | { kind: 'jobs' | 'repository-runners'; repository: number }
  | { kind: 'organization-runners' }
type RequestOptions = Omit<Parameters<typeof githubRequest>[0], 'url' | 'token'>
const api = 'https://api.github.com'
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

/** Owns an ephemeral credential even when its metadata is unusable, so callers can still revoke it. */
export class GitHubCredential {
  readonly #token: string
  readonly #ownsToken: boolean
  readonly #now: () => number
  readonly #valid: boolean
  readonly #until: number
  readonly expiresAt: number | null
  #closed = false
  #retiring = false
  private constructor(token: string, ownsToken: boolean, valid: boolean, expiresAt: number | null, now: () => number) {
    this.#token = token
    this.#ownsToken = ownsToken
    this.#now = now
    this.#valid = valid
    this.expiresAt = expiresAt
    this.#until = Math.min(now() + 60_000, expiresAt === null ? Infinity : expiresAt - 60_000)
  }
  static personal(token: string, now: () => number = Date.now): GitHubCredential {
    if (!token) throw new Error('GitHub personal token required')
    return new GitHubCredential(token, false, true, null, now)
  }
  static installation(
    value: unknown,
    permissions: Record<string, string>,
    repository: number | undefined,
    now: () => number,
  ): GitHubCredential {
    if (!object(value) || typeof value.token !== 'string' || !value.token) throw new GitHubRequestError(undefined, true)
    const expires = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN
    let valid = Number.isFinite(expires) && expires > now() + 60_000 && expires <= now() + 3_660_000
    const granted = value.permissions
    valid = valid && object(granted) && Object.entries(permissions).every(([key, level]) => granted[key] === level)
    if (object(granted))
      valid =
        valid &&
        Object.entries(granted).every(
          ([key, level]) => permissions[key] === level || (key === 'metadata' && level === 'read'),
        )
    if (repository !== undefined)
      valid =
        valid &&
        Array.isArray(value.repositories) &&
        value.repositories.length === 1 &&
        object(value.repositories[0]) &&
        value.repositories[0].id === repository
    return new GitHubCredential(value.token, true, valid, Number.isFinite(expires) ? expires : null, now)
  }
  get usable(): boolean {
    return !this.#closed && !this.#retiring && this.#valid && this.#now() < this.#until
  }
  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    if (!this.usable) throw new Error('GitHub credential is expired, invalid or closed')
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API route')
    return githubRequest({ ...options, url: api + path, token: this.#token })
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#retiring = true
    if (this.#ownsToken) {
      try {
        await githubRequest({
          url: api + '/installation/token',
          token: this.#token,
          method: 'DELETE',
          response: 'empty',
        })
      } catch (error) {
        if (!(error instanceof GitHubRequestError) || error.status !== 401) throw error
      }
    }
    this.#closed = true
  }
  toJSON(): never {
    throw new Error('GitHub credentials are memory-only')
  }
}

/** The controller records issuance intent before issue(); it retains returned handles until close() succeeds. */
export class GitHubAppSource {
  constructor(
    private readonly config: { issuer: string; privateKey: () => KeyLike | Promise<KeyLike>; now?: () => number },
  ) {}
  private get now(): () => number {
    return this.config.now ?? Date.now
  }
  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const jwt = createGitHubAppJwt(this.config.issuer, await this.config.privateKey(), this.now())
    return githubRequest({ ...options, url: api + path, token: jwt })
  }
  async installation(installationId: number, signal?: AbortSignal): Promise<GitHubInstallation> {
    if (!id(installationId)) throw new Error('Invalid GitHub installation identity')
    const actual = this.decode(await this.request(`/app/installations/${installationId}`, { signal }))
    if (actual.id !== installationId) throw new Error('GitHub installation identity changed')
    return actual
  }
  async installations(signal?: AbortSignal): Promise<GitHubInstallation[]> {
    const result: GitHubInstallation[] = [],
      seen = new Set<number>()
    for (let page = 1; page <= 1000; page++) {
      const values = await this.request(`/app/installations?per_page=100&page=${page}`, { signal })
      if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid GitHub installation inventory')
      for (const value of values) {
        const item = this.decode(value)
        if (seen.has(item.id)) throw new Error('Duplicate GitHub installation inventory')
        seen.add(item.id)
        result.push(item)
      }
      if (values.length < 100) return result
    }
    throw new Error('GitHub installation inventory exceeds limit')
  }
  async deliveryPage(cursor?: string, signal?: AbortSignal): Promise<GitHubDeliveryPage> {
    const query = cursor === undefined ? '' : '&cursor=' + encodeURIComponent(deliveryCursor(cursor))
    signal?.throwIfAborted()
    const value = await this.request('/app/hook/deliveries?per_page=100' + query, { signal, response: 'page' })
    return decodeDeliveryPage(value, cursor)
  }
  /** The caller must persist the retry intent and recheck its App root and lease in beforeMutation. */
  async redeliver(id: string, beforeMutation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    id = deliveryId(id)
    if (typeof beforeMutation !== 'function') throw new Error('GitHub delivery intent callback required')
    signal?.throwIfAborted()
    await beforeMutation()
    signal?.throwIfAborted()
    await this.request(`/app/hook/deliveries/${id}/attempts`, { method: 'POST', response: 'empty', signal })
  }
  async issue(
    expected: GitHubInstallation,
    purpose: GitHubTokenPurpose,
    signal?: AbortSignal,
  ): Promise<GitHubCredential> {
    if (!purpose || !['catalog', 'jobs', 'repository-runners', 'organization-runners'].includes(purpose.kind))
      throw new Error('Invalid GitHub token purpose')
    expected = { ...expected, account: { ...expected.account } }
    purpose = { ...purpose }
    const actual = await this.installation(expected.id, signal)
    if (
      actual.account.id !== expected.account.id ||
      actual.account.type !== expected.account.type ||
      actual.account.login.toLowerCase() !== expected.account.login.toLowerCase() ||
      actual.suspended
    )
      throw new Error('GitHub installation authority changed')
    const permission =
      purpose.kind === 'catalog'
        ? 'metadata'
        : purpose.kind === 'jobs'
          ? 'actions'
          : purpose.kind === 'repository-runners'
            ? 'administration'
            : 'organization_self_hosted_runners'
    const level = purpose.kind === 'catalog' || purpose.kind === 'jobs' ? 'read' : 'write'
    if (actual.permissions[permission] !== level && !(level === 'read' && actual.permissions[permission] === 'write'))
      throw new Error('GitHub installation permission denied')
    if (purpose.kind === 'organization-runners' && actual.account.type !== 'Organization')
      throw new Error('Organization runner scope required')
    const repository = 'repository' in purpose ? purpose.repository : undefined
    if (repository !== undefined && !id(repository)) throw new Error('Invalid GitHub repository identity')
    const permissions = { [permission]: level }
    const json: Record<string, Json> = { permissions }
    if (repository !== undefined) json.repository_ids = [repository]
    return GitHubCredential.installation(
      await this.request(`/app/installations/${actual.id}/access_tokens`, { json, signal }),
      permissions,
      repository,
      this.now,
    )
  }
  private decode(value: unknown): GitHubInstallation {
    if (
      !object(value) ||
      !id(value.id) ||
      !object(value.account) ||
      !id(value.account.id) ||
      typeof value.account.login !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.account.login) ||
      (value.account.type !== 'User' && value.account.type !== 'Organization') ||
      !object(value.permissions) ||
      (value.suspended_at !== null && typeof value.suspended_at !== 'string')
    )
      throw new Error('Invalid GitHub installation metadata')
    const permissions: Record<string, string> = Object.create(null)
    for (const [key, level] of Object.entries(value.permissions)) {
      if (typeof level !== 'string') throw new Error('Invalid GitHub permission metadata')
      permissions[key] = level
    }
    return {
      id: value.id,
      account: { id: value.account.id, login: value.account.login, type: value.account.type },
      permissions,
      suspended: value.suspended_at !== null,
    }
  }
}
