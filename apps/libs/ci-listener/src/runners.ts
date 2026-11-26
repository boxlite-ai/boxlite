/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubCredential } from './github-app'
import { GitHubRequestError } from './github'
import { decodeRepository, GitHubRepository } from './jobs'
import { WorkerExecutor } from './worker'
import { parseResourceLabels } from './resource-labels'

export type RunnerScope =
  | { kind: 'repository'; repository: GitHubRepository; allowPublic: boolean; allowPrivate: boolean }
  | {
      kind: 'organization'
      account: { id: number; login: string }
      group: number
      repositories: number[]
      allowPublic: boolean
      allowPrivate: boolean
    }
export interface RunnerIdentity {
  id: number
  name: string
}
export type RunnerEffect = { kind: 'register'; name: string } | { kind: 'remove'; id: number; name: string }
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const workerName = (name: string) => /^ci-jit-[a-f0-9]{32}$/.test(name)

/** The controller persists registration and delivery intents; the encoded JIT itself never enters the journal. */
export class JitRegistration implements RunnerIdentity {
  readonly id: number
  readonly name: string
  readonly #configuration: string | undefined
  #attempted = false
  constructor(identity: RunnerIdentity, configuration: unknown) {
    this.id = identity.id
    this.name = identity.name
    if (
      typeof configuration === 'string' &&
      configuration.length > 0 &&
      configuration.length <= 1_048_576 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(configuration)
    )
      this.#configuration = configuration
    Object.freeze(this)
  }
  get usable(): boolean {
    return !!this.#configuration && !this.#attempted
  }
  async deliver(executor: WorkerExecutor, signal?: AbortSignal): Promise<void> {
    if (!this.usable) throw new Error('JIT configuration is invalid or delivery was already attempted')
    this.#attempted = true
    await executor.deliverJit(this.name, this.#configuration!, signal)
  }
  toJSON(): never {
    throw new Error('JIT configuration is memory-only')
  }
}

/** Verify scope access and unregister a known idle runner after journaling its removal. */
export class GitHubRunners {
  private readonly scope: RunnerScope
  constructor(
    private readonly credential: GitHubCredential,
    scope: RunnerScope,
    labels: readonly string[],
    private readonly beforeMutation: (effect: RunnerEffect) => Promise<void>,
  ) {
    if (
      !labels.length ||
      labels.length > 100 ||
      labels.some(
        (label) => !label || label.length > 128 || Array.from(label).some((char) => char.charCodeAt(0) < 32),
      ) ||
      new Set(labels.map((label) => label.toLowerCase())).size !== labels.length ||
      !parseResourceLabels(labels)
    )
      throw new Error('Invalid GitHub runner labels')
    if (typeof scope.allowPublic !== 'boolean' || typeof scope.allowPrivate !== 'boolean')
      throw new Error('Explicit repository visibility policy required')
    if (scope.kind === 'repository') this.scope = { ...scope, repository: decodeRepository(scope.repository) }
    else {
      if (
        scope.kind !== 'organization' ||
        !positive(scope.account.id) ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(scope.account.login) ||
        !positive(scope.group) ||
        !scope.repositories.length ||
        scope.repositories.length > 100_000 ||
        scope.repositories.some((id) => !positive(id)) ||
        new Set(scope.repositories).size !== scope.repositories.length
      )
        throw new Error('Invalid organization runner scope')
      this.scope = { ...scope, account: { ...scope.account }, repositories: [...scope.repositories] }
    }
  }
  private get route(): string {
    return this.scope.kind === 'repository'
      ? `/repos/${this.scope.repository.owner.login}/${this.scope.repository.name}`
      : `/orgs/${this.scope.account.login}`
  }
  async authority(admission: boolean, signal?: AbortSignal): Promise<ReadonlySet<string>> {
    const scope = this.scope
    if (scope.kind === 'repository') {
      const current = decodeRepository(
          await this.credential.request(`/repositories/${scope.repository.id}`, { signal }),
        ),
        original = scope.repository
      if (
        current.id !== original.id ||
        current.owner.id !== original.owner.id ||
        current.owner.login.toLowerCase() !== original.owner.login.toLowerCase() ||
        current.name.toLowerCase() !== original.name.toLowerCase() ||
        (admission && current.private !== original.private)
      )
        throw new Error('Original runner repository authority changed')
      if (admission && current.private && !scope.allowPrivate)
        throw new Error('Private repository runners are disabled')
      if (admission && !current.private && !scope.allowPublic) throw new Error('Public repository runners are disabled')
      return new Set([current.name.toLowerCase()])
    }
    const account = await this.credential.request(this.route, { signal })
    if (
      !object(account) ||
      account.id !== scope.account.id ||
      typeof account.login !== 'string' ||
      account.login.toLowerCase() !== scope.account.login.toLowerCase()
    )
      throw new Error('Original runner organization authority changed')
    if (!admission) return new Set()
    const group = await this.credential.request(`${this.route}/actions/runner-groups/${scope.group}`, { signal })
    if (
      !object(group) ||
      group.id !== scope.group ||
      group.visibility !== 'selected' ||
      group.inherited !== false ||
      group.restricted_to_workflows !== false ||
      typeof group.allows_public_repositories !== 'boolean' ||
      group.allows_public_repositories !== scope.allowPublic
    )
      throw new Error('Runner group must have an explicit selected-repository policy')
    const selected = await this.inventory(`${this.route}/actions/runner-groups/${scope.group}/repositories`, signal)
    const expected = new Set(scope.repositories)
    const names = new Set<string>()
    for (const value of selected) {
      const repository = decodeRepository(value)
      if (
        !expected.delete(repository.id) ||
        repository.owner.id !== scope.account.id ||
        (repository.private ? !scope.allowPrivate : !scope.allowPublic)
      )
        throw new Error('Runner group repository authorization changed')
      names.add(repository.name.toLowerCase())
    }
    if (expected.size) throw new Error('Runner group repository authorization is incomplete')
    return names
  }
  /** A REST 404 leaves retirement unresolved while the Actions service still lists the original runner. */
  async retireKnownIdle(
    identity: RunnerIdentity,
    absentAfterDelete: () => Promise<RunnerIdentity | null>,
    signal?: AbortSignal,
    checkRetirement?: () => void,
  ): Promise<boolean | null> {
    if (!positive(identity.id) || !workerName(identity.name)) throw new Error('Known original runner required')
    await this.authority(false, signal)
    let value: unknown
    try {
      value = await this.credential.request(this.route + '/actions/runners/' + identity.id, { signal })
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404) return null
      throw error
    }
    if (!object(value) || value.id !== identity.id || value.name !== identity.name)
      throw new Error('Original scale set runner changed')
    if (value.status !== 'online' || value.busy !== false) return false
    return this.deleteIdle(identity, absentAfterDelete, signal, checkRetirement)
  }
  private async deleteIdle(
    identity: RunnerIdentity,
    remaining: () => Promise<RunnerIdentity | null>,
    signal?: AbortSignal,
    checkRetirement?: () => void,
  ): Promise<boolean> {
    await this.beforeMutation({ kind: 'remove', ...identity })
    checkRetirement?.()
    try {
      await this.credential.request(`${this.route}/actions/runners/${identity.id}`, {
        method: 'DELETE',
        response: 'no-content',
        signal,
      })
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 422) return false
      throw error
    }
    if (await remaining()) throw new Error('Idle runner retirement is not yet confirmed')
    return true
  }
  private async inventory(route: string, signal?: AbortSignal): Promise<unknown[]> {
    const result: unknown[] = [],
      seen = new Set<number>()
    let total: number | undefined
    for (let page = 1; page <= 1000; page++) {
      const value = await this.credential.request(`${route}?per_page=100&page=${page}`, { signal })
      if (
        !object(value) ||
        !Number.isSafeInteger(value.total_count) ||
        (value.total_count as number) < 0 ||
        (value.total_count as number) > 100_000 ||
        (total !== undefined && value.total_count !== total) ||
        !Array.isArray(value.repositories) ||
        value.repositories.length > 100
      )
        throw new Error('Incomplete GitHub runner authorization inventory')
      total = value.total_count as number
      for (const item of value.repositories) {
        if (!object(item) || !positive(item.id) || seen.has(item.id))
          throw new Error('Invalid or duplicate GitHub runner authorization inventory')
        seen.add(item.id)
        result.push(item)
      }
      if (result.length > total || (result.length < total && value.repositories.length < 100))
        throw new Error('Incomplete GitHub runner authorization inventory')
      if (result.length === total) return result
    }
    throw new Error('GitHub runner authorization inventory exceeds limit')
  }
}
