/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { InstallationBinding } from './catalog'
import { ExecutionScope, decodeScope, positive } from './execution/model'
import { GitHubRequestError } from './github'
import { LeaseLost, StateCorrupt } from './state/database'
import { ExecutionLease } from './state/store'

export interface InventoryWake {
  key: string
  version: string
  installationId: number
  accountId: number
  repositoryId: number
}
export interface DiscoveryRequest {
  refresh: boolean
  wakes: readonly InventoryWake[]
}
export interface DiscoverySnapshot {
  scopes: ExecutionScope[]
  completed: InventoryWake[]
  pending: boolean
  ready: boolean
}
export interface DirectoryBinding extends InstallationBinding {
  policy: { allowPublic: boolean; group: string }
}
export interface DirectorySource {
  index(lease: ExecutionLease, signal: AbortSignal): Promise<DirectoryBinding[]>
  load(binding: DirectoryBinding, lease: ExecutionLease, signal: AbortSignal): Promise<ExecutionScope[]>
  report(error: unknown, operation: string): void
}
interface Entry {
  binding: DirectoryBinding
  revision: string
  scopes: ExecutionScope[]
  dirty: boolean
  failures: number
  retryAt: number
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

/** One background catalog slot per App; waiting on a retry never occupies it. */
export class InstallationDirectory {
  private entries = new Map<number, Entry>()
  private readonly hints = new Map<string, InventoryWake>()
  private readonly completed = new Map<string, InventoryWake>()
  private leaseKey = ''
  private stop = new AbortController()
  private task?: Promise<void>
  private fatal?: unknown
  private indexWanted = true
  private refreshAll = true
  private indexed = false
  private indexFailures = 0
  private indexRetryAt = 0
  private cursor = 0
  private hintedTurns = 0
  private lastWasIndex = false
  private closed = false
  constructor(private readonly source: DirectorySource) {}

  step(original: ExecutionLease, request: DiscoveryRequest, signal: AbortSignal): DiscoverySnapshot {
    if (this.closed) throw new Error('Installation directory is closed')
    signal.throwIfAborted()
    const lease = { ...original },
      key = JSON.stringify(lease)
    if (key !== this.leaseKey) {
      this.stop.abort()
      this.stop = new AbortController()
      this.leaseKey = key
      this.entries.clear()
      this.hints.clear()
      this.completed.clear()
      this.indexWanted = this.refreshAll = true
      this.indexed = false
      this.indexFailures = this.indexRetryAt = this.cursor = 0
      this.hintedTurns = 0
      this.lastWasIndex = false
      this.fatal = undefined
    }
    if (this.fatal) throw this.fatal
    if (request.refresh) this.indexWanted = this.refreshAll = true
    const active = new Map<string, InventoryWake>()
    if (request.wakes.length > 100000) throw new StateCorrupt()
    for (const supplied of request.wakes) {
      const hint = { ...supplied }
      if (
        !positive(hint.installationId) ||
        !positive(hint.accountId) ||
        !Number.isSafeInteger(hint.repositoryId) ||
        hint.repositoryId < 0 ||
        hint.key !== `wake/${hint.installationId}/${hint.repositoryId}` ||
        !uuid.test(hint.version) ||
        active.has(hint.key)
      )
        throw new StateCorrupt()
      active.set(hint.key, hint)
      if (this.hints.get(hint.key)?.version === hint.version || this.completed.get(hint.key)?.version === hint.version)
        continue
      this.hints.set(hint.key, hint)
      this.completed.delete(hint.key)
      const entry = this.entries.get(hint.installationId)
      if (entry && entry.binding.installation.account.id !== hint.accountId) throw new StateCorrupt()
      if (entry) entry.dirty = true
      if (!entry || hint.repositoryId === 0) this.indexWanted = true
    }
    for (const map of [this.hints, this.completed])
      for (const [id, hint] of map) if (active.get(id)?.version !== hint.version) map.delete(id)
    if (!this.task) {
      const entries = [...this.entries.values()],
        hinted = new Set([...this.hints.values()].map((hint) => hint.installationId)),
        eligible = this.indexed
          ? entries
              .map((_, offset) => ({ index: (this.cursor + offset) % entries.length }))
              .map(({ index }) => ({ index, entry: entries[index] }))
              .filter(({ entry }) => entry.dirty && entry.retryAt <= Date.now())
          : [],
        urgent = eligible.find(({ entry }) => hinted.has(entry.binding.installation.id)),
        background = eligible.find(({ entry }) => !hinted.has(entry.binding.installation.id)),
        next = urgent && (this.hintedTurns < 3 || !background) ? urgent : background
      // New inventory events cannot monopolize the slot; cold hints still lead catalog work.
      if (this.indexWanted && this.indexRetryAt <= Date.now() && (!this.lastWasIndex || !next))
        this.start(lease, signal)
      else if (next) {
        this.cursor = next.index + 1
        this.hintedTurns = next === urgent ? Math.min(3, this.hintedTurns + 1) : 0
        this.start(lease, signal, next.entry)
      }
    }
    const pending =
      !this.indexed ||
      this.indexWanted ||
      !!this.task ||
      this.hints.size > 0 ||
      [...this.entries.values()].some((entry) => entry.dirty)
    return {
      scopes: this.indexed ? [...this.entries.values()].flatMap((entry) => entry.scopes.map(decodeScope)) : [],
      completed: [...this.completed.values()].map((hint) => ({ ...hint })),
      pending,
      ready: this.indexed && !pending,
    }
  }
  async close(): Promise<void> {
    this.closed = true
    this.stop.abort()
    await this.task
  }
  private revision(binding: DirectoryBinding): string {
    const account = binding.installation.account
    if (
      !positive(binding.installation.id) ||
      !positive(account.id) ||
      !positive(binding.generation) ||
      !binding.binding ||
      !binding.organization ||
      !binding.actor ||
      !['User', 'Organization'].includes(account.type) ||
      typeof binding.policy.allowPublic !== 'boolean'
    )
      throw new StateCorrupt()
    return JSON.stringify([
      binding.binding,
      binding.generation,
      binding.organization,
      binding.actor,
      binding.installation.id,
      account.id,
      account.login.toLowerCase(),
      account.type,
      binding.installation.suspended,
      binding.policy.allowPublic,
      binding.policy.group,
    ])
  }
  private acknowledge(hints: InventoryWake[]): void {
    for (const hint of hints) {
      if (this.hints.get(hint.key)?.version !== hint.version) continue
      this.completed.set(hint.key, { ...hint })
      this.hints.delete(hint.key)
    }
  }
  private backoff(failures: number, error: unknown): number {
    return Math.max(
      Date.now() + Math.min(300000, 60000 * 2 ** Math.min(failures - 1, 3)),
      error instanceof GitHubRequestError ? (error.retryAt ?? 0) : 0,
    )
  }
  private start(lease: ExecutionLease, external: AbortSignal, entry?: Entry): void {
    this.lastWasIndex = !entry
    const key = this.leaseKey,
      signal = AbortSignal.any([external, this.stop.signal, AbortSignal.timeout(entry ? 45000 : 120000)]),
      captured = [...this.hints.values()].map((hint) => ({ ...hint })),
      refresh = this.refreshAll,
      binding = entry ? structuredClone(entry.binding) : undefined
    if (entry) entry.dirty = false
    else {
      this.indexWanted = false
      this.refreshAll = false
    }
    const current = () => {
      signal.throwIfAborted()
      if (this.leaseKey !== key) throw new LeaseLost()
    }
    const work = (async () => {
      try {
        if (entry && binding) {
          const scopes = (await this.source.load(structuredClone(binding), { ...lease }, signal)).map(decodeScope)
          current()
          for (const scope of scopes)
            if (
              scope.binding !== binding.binding ||
              scope.generation !== binding.generation ||
              scope.organization !== binding.organization ||
              scope.actor !== binding.actor ||
              scope.installation.id !== binding.installation.id ||
              scope.installation.account.id !== binding.installation.account.id ||
              scope.installation.account.login !== binding.installation.account.login.toLowerCase() ||
              scope.installation.account.type !== binding.installation.account.type ||
              scope.runners.allowPublic !== binding.policy.allowPublic
            )
              throw new StateCorrupt()
          const repositoryCount = (values: ExecutionScope[]) =>
            values.reduce(
              (count, scope) => count + (scope.runners.kind === 'repository' ? 1 : scope.runners.repositories.length),
              0,
            )
          const total = [...this.entries.values()].reduce(
            (count, other) => count + repositoryCount(other === entry ? scopes : other.scopes),
            0,
          )
          if (total > 100000) throw new Error('App repository directory capacity exceeded')
          entry.scopes = scopes
          entry.failures = entry.retryAt = 0
          this.acknowledge(
            captured.filter(
              (hint) =>
                hint.installationId === binding.installation.id && hint.accountId === binding.installation.account.id,
            ),
          )
        } else {
          const bindings = (await this.source.index({ ...lease }, signal)).map((value) => structuredClone(value))
          current()
          if (bindings.length > 10000) throw new Error('Installation directory capacity exceeded')
          const next = new Map<number, Entry>()
          for (const binding of bindings) {
            const id = binding.installation.id,
              revision = this.revision(binding)
            if (next.has(id)) throw new StateCorrupt()
            const previous = this.entries.get(id)
            next.set(
              id,
              previous?.revision === revision
                ? previous
                : { binding, revision, scopes: [], dirty: true, failures: 0, retryAt: 0 },
            )
            if (refresh) next.get(id)!.dirty = true
          }
          this.entries = next
          this.indexed = true
          this.indexFailures = this.indexRetryAt = 0
          this.acknowledge(captured.filter((hint) => !next.has(hint.installationId)))
        }
      } catch (error) {
        if (key !== this.leaseKey || external.aborted || this.closed) return
        if (error instanceof LeaseLost || (!entry && error instanceof StateCorrupt)) this.fatal = error
        if (entry) {
          entry.scopes = []
          entry.dirty = true
          entry.retryAt = this.backoff(++entry.failures, error)
        } else {
          this.indexed = false
          this.indexWanted = true
          this.refreshAll ||= refresh
          this.indexRetryAt = this.backoff(++this.indexFailures, error)
        }
        this.source.report(error, entry ? 'installation-discovery' : 'installation-index')
      }
    })()
    this.task = work
      .catch((error) => {
        this.fatal = error
      })
      .finally(() => {
        if (this.task === tracked) this.task = undefined
      })
    const tracked = this.task
  }
}
