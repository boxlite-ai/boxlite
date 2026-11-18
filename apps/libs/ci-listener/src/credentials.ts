/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { GitHubAppSource, GitHubCredential, GitHubInstallation, GitHubTokenPurpose } from './github-app'
import { Json, LeaseLost, StateRecord } from './state/database'
import { ExecutionLease, ListenerState } from './state/store'

export type CredentialSource =
  | { kind: 'app'; app: GitHubAppSource; installation: GitHubInstallation }
  | { kind: 'pat'; repository: number; token: () => string | Promise<string> }
export interface CredentialBorrow {
  credential: GitHubCredential
  close(): Promise<void>
}
interface Entry {
  record: StateRecord
  credential: GitHubCredential
  retiring?: Promise<void>
}

/** Shared issuance/retirement owner. Hosts supply secrets; neither tokens nor key material enter state. */
export class ListenerCredentials {
  readonly #source: CredentialSource
  private readonly lease: ExecutionLease
  private readonly held = new Map<string, Entry>()
  private readonly busy = new Map<string, symbol>()
  private readonly retryAt = new Map<string, number>()
  private closed = false
  constructor(
    private readonly state: Pick<ListenerState, 'commit'>,
    lease: ExecutionLease,
    private readonly owner: string,
    source: CredentialSource,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,149}$/.test(owner)) throw new Error('Invalid GitHub credential owner')
    this.lease = { ...lease }
    if (source.kind === 'app')
      this.#source = {
        ...source,
        installation: {
          ...source.installation,
          account: { ...source.installation.account },
          permissions: { ...source.installation.permissions },
        },
      }
    else {
      if (source.kind !== 'pat' || !Number.isSafeInteger(source.repository) || source.repository <= 0)
        throw new Error('A pinned personal-token repository is required')
      this.#source = { ...source }
    }
  }
  async open(request: GitHubTokenPurpose, signal?: AbortSignal): Promise<CredentialBorrow> {
    const purpose = this.purpose(request),
      source = this.#source,
      key = purpose.kind + ('repository' in purpose ? '/' + purpose.repository : '')
    if (this.closed) throw new Error('GitHub credential provider is closed')
    if (this.busy.has(key)) throw new Error('GitHub credential purpose is already in use')
    if (
      source.kind === 'pat' &&
      (purpose.kind === 'organization-runners' || ('repository' in purpose && purpose.repository !== source.repository))
    )
      throw new Error('Personal-token request is outside its pinned repository')
    const borrower = Symbol(key)
    this.busy.set(key, borrower)
    const release = () => {
      if (this.busy.get(key) === borrower) this.busy.delete(key)
    }
    let created: Entry | undefined
    try {
      signal?.throwIfAborted()
      await this.retire(key)
      if ((this.retryAt.get(key) ?? 0) > Date.now()) throw new Error('GitHub credential issuance retry is deferred')
      const operation = randomUUID(),
        recordKey = `credential/${this.owner}/${operation}`
      const payload: Record<string, Json> = {
        operation,
        purpose: purpose as unknown as Json,
        installation: source.kind === 'app' ? source.installation.id : 0,
        requestedAt: Date.now(),
        phase: 'requested',
        holder: {
          owner: this.lease.owner,
          epoch: this.lease.epoch,
          ...(this.lease.deployment === undefined ? {} : { deployment: this.lease.deployment }),
        },
      }
      const [intent] = await this.state.commit(this.lease, [{ key: recordKey, expected: null, payload }])
      let credential: GitHubCredential
      try {
        credential =
          source.kind === 'app'
            ? await source.app.issue(source.installation, purpose, signal)
            : GitHubCredential.personal(await source.token())
      } catch (error) {
        this.retryAt.set(key, Date.now() + 60_000)
        throw error
      }
      created = { record: intent, credential }
      this.held.set(key, created)
      const [issued] = await this.state.commit(this.lease, [
        {
          key: recordKey,
          expected: intent.version,
          payload: { ...payload, phase: 'issued', expiresAt: credential.expiresAt },
        },
      ])
      created.record = issued
      if (this.closed || !credential.usable) throw new Error('GitHub credential is unavailable or provider is closed')
      const owned = created
      let released = false
      return {
        credential,
        close: async () => {
          if (released) return
          try {
            await this.retire(key, owned)
            released = true
          } finally {
            release()
          }
        },
      }
    } catch (error) {
      release()
      if (created) {
        try {
          await this.retire(key, created)
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'GitHub credential operation and retirement failed')
        }
      }
      throw error
    }
  }
  async close(): Promise<void> {
    this.closed = true
    const errors: unknown[] = []
    for (const key of this.held.keys())
      try {
        await this.retire(key)
      } catch (error) {
        errors.push(error)
      }
    if (errors.length) throw new AggregateError(errors, 'GitHub credential retirement remains pending')
  }
  private async retire(key: string, expected?: Entry): Promise<void> {
    const entry = this.held.get(key)
    if (!entry || (expected && entry !== expected)) return
    if (entry.retiring) return entry.retiring
    const retirement = (async () => {
      await entry.credential.close()
      try {
        await this.state.commit(this.lease, [{ key: entry.record.key, expected: entry.record.version }])
      } catch (error) {
        // The token is closed. Its metadata now belongs to the current owner's
        // collector; a lost lease cannot become permanent local cleanup debt.
        if (!(error instanceof LeaseLost)) throw error
      }
      if (this.held.get(key) === entry) this.held.delete(key)
    })()
    entry.retiring = retirement
    try {
      await retirement
    } finally {
      if (entry.retiring === retirement) entry.retiring = undefined
    }
  }
  private purpose(value: GitHubTokenPurpose): GitHubTokenPurpose {
    if (!value || !['catalog', 'jobs', 'repository-runners', 'organization-runners'].includes(value.kind))
      throw new Error('Invalid GitHub credential purpose')
    if (value.kind === 'jobs' || value.kind === 'repository-runners') {
      if (!Number.isSafeInteger(value.repository) || value.repository <= 0)
        throw new Error('Invalid GitHub credential repository')
      return { kind: value.kind, repository: value.repository }
    }
    return { kind: value.kind }
  }
  toJSON(): never {
    throw new Error('GitHub credential providers are memory-only')
  }
}
