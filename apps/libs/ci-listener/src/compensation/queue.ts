/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash, randomUUID } from 'node:crypto'
import { decodeScope, ExecutionScope, object, positive, scopeKey } from '../execution/model'
import { jobMatches, WorkflowJob } from '../jobs'
import { repositories } from '../scheduling'
import {
  Json,
  LeaseLost,
  StateConflict,
  StateCorrupt,
  StateDatabase,
  StateRecord,
  StateTransaction,
} from '../state/database'
import type { ExecutionLease, ListenerState, StateCheck } from '../state/store'

export interface ScanClaim extends ExecutionLease {
  id: string
  revision: string
  application: string
  scope: ExecutionScope
  repository: number
}
interface Catalog {
  revision: string
  fingerprint: string
  staging: string
  wanted: string
  enabled: boolean
  stagedScopes: number
  stagedTasks: number
}
interface Task {
  application: string
  scope: string
  repository: number
  binding: string
  installation: string
  nextAt: number
  owner: string
  epoch: number
  until: number
  failures: number
}
interface Installation {
  owner: string
  task: string
  epoch: number
  until: number
  retryAt: number
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (value: unknown) => value as Json
const record = (key: string, payload: unknown): StateRecord => ({
  key,
  payload: json(payload),
  schema: 1,
  version: randomUUID(),
})
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const stamp = (value: number) => {
  if (!time(value)) throw new StateCorrupt()
  return String(value).padStart(16, '0')
}
const due = (task: string, at: number) => `scan/due/${stamp(at)}/${task}`
const bindingId = (application: string, binding: string) => hash([application, binding])
const taskId = (application: string, scope: ExecutionScope, repository: number) =>
  hash([application, scopeKey(scope), repository])
const member = (revision: string, id: string) => `scan/member/${revision}/${id}`
const decode = <T>(row: StateRecord | undefined): T => {
  if (!row || row.schema !== 1 || !object(row.payload)) throw new StateCorrupt()
  return row.payload as T
}

/** Scan ownership never grants the execution journal's lease or worker capabilities. */
export class RepositoryScanQueue {
  constructor(
    private readonly database: StateDatabase,
    private readonly namespace: string,
    private readonly executionFence: (tx: StateTransaction, lease: ExecutionLease) => Promise<unknown>,
  ) {}

  /** Called only after one binding's complete catalog succeeds, including a successful empty result. */
  async synchronize(
    lease: ExecutionLease,
    application: string,
    binding: string,
    scopes: readonly ExecutionScope[],
    signal?: AbortSignal,
  ): Promise<void> {
    lease = { ...lease }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(application) || !binding) throw new StateCorrupt()
    const canonical = scopes
      .map(decodeScope)
      .map((scope) => ({ scope, reference: scopeKey(scope) }))
      .sort((a, b) => a.reference.localeCompare(b.reference))
    const definitions = canonical.map((entry) => entry.scope)
    if (definitions.some((scope) => scope.binding !== binding)) throw new StateCorrupt()
    const entries = canonical.flatMap(({ scope, reference }) =>
      repositories(scope).map((repository) => ({
        scope,
        reference,
        repository,
        id: hash([application, reference, repository]),
      })),
    )
    entries.sort((a, b) => a.id.localeCompare(b.id))
    if (entries.length > 100000 || new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new StateCorrupt()
    const id = bindingId(application, binding),
      key = 'scan/catalog/' + id,
      fingerprint = hash(entries.map((entry) => entry.id))
    signal?.throwIfAborted()
    const build = await this.database.transaction(this.namespace, async (tx) => {
      await this.executionFence(tx, lease)
      const prior = await tx.get(key, true)
      const value = prior
        ? this.catalog(prior)
        : { revision: '', fingerprint: '', staging: '', wanted: '', enabled: true, stagedScopes: 0, stagedTasks: 0 }
      if (value.enabled && value.fingerprint === fingerprint) {
        if (value.staging) {
          await this.put(
            tx,
            'scan/gc/' + value.staging,
            { revision: value.staging },
            await tx.get('scan/gc/' + value.staging),
          )
          await this.put(tx, key, { ...value, staging: '', wanted: '', stagedScopes: 0, stagedTasks: 0 }, prior)
        }
        return undefined
      }
      const next = value.wanted === fingerprint && value.staging ? value.staging : randomUUID()
      if (value.staging && value.staging !== next)
        await this.put(
          tx,
          'scan/gc/' + value.staging,
          { revision: value.staging },
          await tx.get('scan/gc/' + value.staging),
        )
      const stagedScopes = value.staging === next ? value.stagedScopes : 0,
        stagedTasks = value.staging === next ? value.stagedTasks : 0
      await this.put(tx, key, { ...value, staging: next, wanted: fingerprint, stagedScopes, stagedTasks }, prior)
      await this.put(tx, 'scan/active/' + id, { id }, await tx.get('scan/active/' + id))
      return { revision: next, stagedScopes, stagedTasks }
    })
    if (!build) return
    const { revision } = build
    for (let offset = build.stagedScopes; offset < definitions.length; offset += 25) {
      signal?.throwIfAborted()
      await this.database.transaction(this.namespace, async (tx) => {
        await this.executionFence(tx, lease)
        const root = await tx.get(key, true),
          catalog = this.catalog(root)
        if (catalog.staging !== revision) throw new StateConflict()
        for (const definition of definitions.slice(offset, offset + 25)) {
          const key = 'scan/' + scopeKey(definition),
            prior = await tx.get(key)
          if (!prior) await this.put(tx, key, { application, scope: definition })
          else {
            const stored = decode<{ application: string; scope: unknown }>(prior)
            if (stored.application !== application || scopeKey(decodeScope(stored.scope)) !== scopeKey(definition))
              throw new StateCorrupt()
          }
        }
        await this.put(tx, key, { ...catalog, stagedScopes: Math.min(offset + 25, definitions.length) }, root)
        await this.executionFence(tx, lease)
      })
    }
    for (let offset = build.stagedTasks; offset < entries.length; offset += 25) {
      signal?.throwIfAborted()
      await this.database.transaction(this.namespace, async (tx) => {
        await this.executionFence(tx, lease)
        const root = await tx.get(key, true),
          catalog = this.catalog(root)
        if (catalog.staging !== revision) throw new StateConflict()
        for (const entry of entries.slice(offset, offset + 25)) {
          const taskKey = 'scan/task/' + entry.id
          if (!(await tx.get(taskKey))) {
            const installation = hash([
              application,
              entry.scope.installation.id,
              entry.scope.installation.id ? null : entry.repository,
            ])
            const task: Task = {
              application,
              scope: entry.reference,
              repository: entry.repository,
              binding: id,
              installation,
              nextAt: 0,
              owner: '',
              epoch: 0,
              until: 0,
              failures: 0,
            }
            await this.put(tx, taskKey, task)
            await this.put(tx, due(entry.id, 0), { id: entry.id })
          }
          const key = member(revision, entry.id)
          if (!(await tx.get(key))) await this.put(tx, key, { id: entry.id })
        }
        await this.put(tx, key, { ...catalog, stagedTasks: Math.min(offset + 25, entries.length) }, root)
        await this.executionFence(tx, lease)
      })
    }
    signal?.throwIfAborted()
    await this.database.transaction(this.namespace, async (tx) => {
      await this.executionFence(tx, lease)
      const row = await tx.get(key, true),
        value = this.catalog(row)
      if (
        value.staging !== revision ||
        value.stagedScopes !== definitions.length ||
        value.stagedTasks !== entries.length
      )
        throw new StateConflict()
      await this.put(
        tx,
        key,
        { revision, fingerprint, staging: '', wanted: '', enabled: true, stagedScopes: 0, stagedTasks: 0 },
        row,
      )
      if (value.revision) await this.put(tx, 'scan/gc/' + value.revision, { revision: value.revision })
      await this.executionFence(tx, lease)
    })
  }

  /** A successful authoritative installation index can retire bindings; partial discovery cannot. */
  async reconcile(lease: ExecutionLease, current: readonly { application: string; binding: string }[]): Promise<void> {
    lease = { ...lease }
    const active = new Set(current.map((entry) => bindingId(entry.application, entry.binding)))
    let after = ''
    for (;;) {
      const rows = await this.database.transaction(this.namespace, async (tx) => {
        await this.executionFence(tx, lease)
        const rows = await tx.page(after, 50, 'scan/active/')
        for (const row of rows) {
          const id = row.key.slice('scan/active/'.length)
          if (active.has(id)) continue
          const key = 'scan/catalog/' + id,
            prior = await tx.get(key, true),
            catalog = this.catalog(prior)
          await this.put(
            tx,
            key,
            { ...catalog, enabled: false, staging: '', wanted: '', stagedScopes: 0, stagedTasks: 0 },
            prior,
          )
          await this.remove(tx, row)
          if (catalog.revision)
            await this.put(
              tx,
              'scan/gc/' + catalog.revision,
              { revision: catalog.revision },
              await tx.get('scan/gc/' + catalog.revision),
            )
          if (catalog.staging)
            await this.put(
              tx,
              'scan/gc/' + catalog.staging,
              { revision: catalog.staging },
              await tx.get('scan/gc/' + catalog.staging),
            )
        }
        await this.executionFence(tx, lease)
        return rows
      })
      if (rows.length < 50) return
      after = rows[rows.length - 1].key
    }
  }

  async claim(owner: string, ttlMs = 60000): Promise<ScanClaim | undefined> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner) || !positive(ttlMs) || ttlMs > 300000)
      throw new Error('Invalid scan lease')
    // Candidate locks are released before the ownership transaction. All actual
    // ownership writes lock catalog -> installation -> task -> due index.
    const candidates = await this.database.transaction(this.namespace, async (tx) => ({
      rows: await tx.page('', 16, 'scan/due/', 'skip-locked'),
      now: await tx.now(),
    }))
    for (const candidate of candidates.rows) {
      if (Number(candidate.key.split('/')[2]) > candidates.now) break
      const claim = await this.database.transaction(this.namespace, async (tx) => {
        const now = await tx.now(),
          entry = decode<{ id: string }>(candidate)
        if (!/^[a-f0-9]{64}$/.test(entry.id) || candidate.key !== due(entry.id, Number(candidate.key.split('/')[2])))
          throw new StateCorrupt()
        if (Number(candidate.key.split('/')[2]) > now) return undefined
        const original = await tx.get('scan/task/' + entry.id)
        if (!original) {
          const stale = await tx.get(candidate.key, true)
          if (stale?.version === candidate.version) await this.remove(tx, stale)
          return undefined
        }
        const task = this.task(original, entry.id),
          root = await tx.get('scan/catalog/' + task.binding, true),
          catalog = this.catalog(root)
        const groupKey = 'scan/installation/' + task.installation
        let group = await tx.get(groupKey, true)
        if (!group) {
          await this.put(tx, groupKey, { owner: '', task: '', epoch: 0, until: 0, retryAt: 0 })
          group = await tx.get(groupKey, true)
        }
        const installation = this.installation(group),
          row = await tx.get(original.key, true)
        if (!row || row.version !== original.version) return undefined
        const index = await tx.get(candidate.key, true)
        if (!index || index.version !== candidate.version || task.nextAt > now) return undefined
        if (!catalog.enabled || !(await tx.get(member(catalog.revision, entry.id)))) {
          if (catalog.staging && (await tx.get(member(catalog.staging, entry.id)))) {
            await this.reschedule(tx, entry.id, row, task, now + 1000)
          } else {
            await this.remove(tx, row)
            await this.remove(tx, index)
          }
          return undefined
        }
        const blockedUntil = Math.max(task.until, installation.until, installation.retryAt)
        if (blockedUntil > now) {
          await this.reschedule(tx, entry.id, row, task, blockedUntil)
          return undefined
        }
        if (task.epoch === Number.MAX_SAFE_INTEGER) throw new StateCorrupt()
        const next = { ...task, owner, epoch: task.epoch + 1, until: now + ttlMs }
        await this.reschedule(tx, entry.id, row, next, next.until)
        await this.put(
          tx,
          groupKey,
          { ...installation, owner, task: entry.id, epoch: next.epoch, until: next.until },
          group,
        )
        return {
          namespace: this.namespace,
          owner,
          epoch: next.epoch,
          id: entry.id,
          revision: catalog.revision,
          application: task.application,
          scope: await this.scope(tx, task),
          repository: task.repository,
        }
      })
      if (claim) return claim
    }
    return undefined
  }

  async check(original: ScanClaim): Promise<void> {
    const claim = this.capture(original)
    await this.database.transaction(this.namespace, (tx) => this.assert(tx, claim))
  }

  async publish(
    original: ScanClaim,
    jobs: readonly WorkflowJob[],
    labels: readonly string[],
    checks: readonly StateCheck[] = [],
  ): Promise<void> {
    const supported = [...labels]
    const claim = this.capture(original),
      captured = jobs.map((job) => ({ ...job, labels: [...job.labels] })),
      fences = checks.map((check) => ({ ...check }))
    if (captured.length > 50) throw new Error('Scan publication batch exceeded')
    await this.database.transaction(this.namespace, async (tx) => {
      // Hosts lock live binding authority before entering this transaction.
      for (const check of fences.sort((a, b) => a.key.localeCompare(b.key))) {
        if ((await tx.get(check.key, true))?.version !== check.version) throw new StateConflict()
      }
      await this.assert(tx, claim)
      for (const job of captured) {
        if (job.repository !== claim.repository || !positive(job.job) || !positive(job.run)) throw new StateCorrupt()
        if (!jobMatches(job, supported)) continue
        const key = `notice/${claim.scope.installation.id}/${job.job}`
        let prior = await tx.get(key, true)
        if (!prior) {
          const next = record(key, {
            installationId: claim.scope.installation.id,
            accountId: claim.scope.installation.account.id,
            repositoryId: claim.repository,
            job: { id: job.job, runId: job.run },
          })
          if (await tx.put(next, null)) continue
          prior = await tx.get(key, true)
        }
        const value = decode<{
          installationId: number
          accountId: number
          repositoryId: number
          job: { id: number; runId: number }
        }>(prior)
        if (
          value.installationId !== claim.scope.installation.id ||
          value.accountId !== claim.scope.installation.account.id ||
          value.repositoryId !== claim.repository ||
          !object(value.job) ||
          value.job.id !== job.job ||
          value.job.runId !== job.run
        )
          throw new StateCorrupt()
      }
      await this.assert(tx, claim)
    })
  }

  async finish(original: ScanClaim, result: { success: boolean; intervalMs: number; retryAt?: number }): Promise<void> {
    result = { ...result }
    const claim = this.capture(original)
    if (!positive(result.intervalMs) || (result.retryAt !== undefined && !time(result.retryAt)))
      throw new Error('Invalid scan deadline')
    await this.database.transaction(this.namespace, async (tx) => {
      const { row, task, group, installation } = await this.assert(tx, claim),
        now = await tx.now()
      const failures = result.success ? 0 : Math.min(task.failures + 1, 32)
      const nextAt = Math.max(
        now + (result.success ? result.intervalMs : Math.min(300000, 1000 * 2 ** Math.min(failures - 1, 9))),
        result.retryAt ?? 0,
      )
      await this.reschedule(tx, claim.id, row, { ...task, owner: '', until: 0, failures }, nextAt)
      await this.put(
        tx,
        group.key,
        {
          ...installation,
          owner: '',
          task: '',
          until: 0,
          retryAt: Math.max(installation.retryAt, result.retryAt ?? 0),
        },
        group,
      )
    })
  }

  /** Cleanup-only CAS survives lease loss, without granting another issuance or notice write. */
  credentials(original: ScanClaim): Pick<ListenerState, 'commit'> {
    const claim = this.capture(original)
    return {
      commit: async (lease, changes) => {
        if (lease.namespace !== claim.namespace || lease.owner !== claim.owner || lease.epoch !== claim.epoch)
          throw new LeaseLost()
        const captured = changes.map((change) => ({
          ...change,
          payload: change.payload === undefined ? undefined : (JSON.parse(JSON.stringify(change.payload)) as Json),
        }))
        if (captured.length !== 1) throw new Error('One original scan credential required')
        return this.database.transaction(this.namespace, async (tx) => {
          const change = captured[0],
            prefix = `credential/scan/${claim.id}/`
          if (
            !change.key.startsWith(prefix) ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(change.key.slice(prefix.length))
          )
            throw new StateCorrupt()
          if (change.payload !== undefined) await this.assert(tx, claim)
          const prior = await tx.get(change.key, true)
          if (!prior && change.payload === undefined) return []
          if (
            prior &&
            (prior.version !== change.expected ||
              !object(prior.payload) ||
              !object(prior.payload.scan) ||
              prior.payload.scan.owner !== claim.owner ||
              prior.payload.scan.epoch !== claim.epoch ||
              prior.payload.scan.task !== claim.id)
          )
            throw new StateConflict()
          if (change.payload === undefined) {
            await this.remove(tx, prior!)
            return []
          }
          if (
            !object(change.payload) ||
            change.payload.operation !== change.key.slice(prefix.length) ||
            !object(change.payload.purpose) ||
            change.payload.purpose.kind !== 'jobs' ||
            change.payload.purpose.repository !== claim.repository
          )
            throw new StateCorrupt()
          const next = record(change.key, {
            ...change.payload,
            scan: { task: claim.id, owner: claim.owner, epoch: claim.epoch },
          })
          if (!(await tx.put(next, change.expected))) throw new StateConflict()
          if (!prior)
            await this.put(
              tx,
              `scan/credential-due/${stamp((await tx.now()) + 7200000)}/${claim.id}/${change.key.slice(prefix.length)}`,
              { key: change.key },
            )
          await this.assert(tx, claim)
          return [next]
        })
      },
    }
  }

  async collect(): Promise<void> {
    await this.database.transaction(this.namespace, async (tx) => {
      const now = await tx.now()
      for (const index of await tx.page('', 16, 'scan/credential-due/', 'skip-locked')) {
        const parts = index.key.split('/'),
          expires = Number(parts[2])
        if (!time(expires) || parts[2] !== stamp(expires)) throw new StateCorrupt()
        if (expires > now) break
        const value = decode<{ key: string }>(index)
        if (
          parts.length !== 5 ||
          value.key !== `credential/scan/${parts[3]}/${parts[4]}` ||
          !/^credential\/scan\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(value.key)
        )
          throw new StateCorrupt()
        const row = await tx.get(value.key, true)
        if (row) await this.remove(tx, row)
        await this.remove(tx, index)
      }
      for (const marker of await tx.page('', 1, 'scan/gc/', 'skip-locked')) {
        const value = decode<{ revision: string }>(marker)
        if (!/^[a-f0-9-]{36}$/.test(value.revision)) throw new StateCorrupt()
        const rows = await tx.page('', 50, `scan/member/${value.revision}/`)
        for (const row of rows) await this.remove(tx, row)
        if (rows.length < 50) await this.remove(tx, marker)
      }
    })
  }

  private capture(value: ScanClaim): ScanClaim {
    const scope = decodeScope(value.scope),
      captured = { ...value, scope }
    if (
      value.namespace !== this.namespace ||
      !positive(value.epoch) ||
      !value.owner ||
      value.id !== taskId(value.application, scope, value.repository) ||
      !/^[a-f0-9-]{36}$/.test(value.revision)
    )
      throw new LeaseLost()
    return captured
  }
  private task(row: StateRecord, id: string): Task {
    const value = decode<Task>(row)
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.application) ||
      typeof value.scope !== 'string' ||
      !/^scope\/[a-f0-9]{64}$/.test(value.scope) ||
      !positive(value.repository) ||
      hash([value.application, value.scope, value.repository]) !== id ||
      !/^[a-f0-9]{64}$/.test(value.binding) ||
      !time(value.nextAt) ||
      !time(value.until) ||
      !time(value.epoch) ||
      !time(value.failures) ||
      typeof value.owner !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.installation)
    )
      throw new StateCorrupt()
    return value
  }
  private async scope(tx: StateTransaction, task: Task): Promise<ExecutionScope> {
    const value = decode<{ application: string; scope: unknown }>(await tx.get('scan/' + task.scope))
    const scope = decodeScope(value.scope)
    if (
      value.application !== task.application ||
      scopeKey(scope) !== task.scope ||
      task.binding !== bindingId(task.application, scope.binding) ||
      !repositories(scope).includes(task.repository) ||
      task.installation !==
        hash([task.application, scope.installation.id, scope.installation.id ? null : task.repository])
    )
      throw new StateCorrupt()
    return scope
  }
  private async assert(tx: StateTransaction, claim: ScanClaim) {
    const original = await tx.get('scan/task/' + claim.id)
    if (!original) throw new LeaseLost()
    const task = this.task(original, claim.id),
      catalog = this.catalog(await tx.get('scan/catalog/' + task.binding, true))
    const group = await tx.get('scan/installation/' + task.installation, true),
      installation = this.installation(group),
      row = await tx.get(original.key, true)
    if (
      !row ||
      row.version !== original.version ||
      !catalog.enabled ||
      catalog.revision !== claim.revision ||
      !(await tx.get(member(claim.revision, claim.id))) ||
      task.scope !== scopeKey(claim.scope) ||
      task.binding !== bindingId(claim.application, claim.scope.binding) ||
      task.installation !==
        hash([claim.application, claim.scope.installation.id, claim.scope.installation.id ? null : claim.repository]) ||
      task.owner !== claim.owner ||
      task.epoch !== claim.epoch ||
      task.until <= (await tx.now()) ||
      installation.owner !== claim.owner ||
      installation.task !== claim.id ||
      installation.epoch !== claim.epoch ||
      installation.until <= (await tx.now())
    )
      throw new LeaseLost()
    return { row, task, group: group!, installation }
  }
  private catalog(row: StateRecord | undefined): Catalog {
    const value = decode<Catalog>(row),
      revision = (v: unknown) => v === '' || (typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v)),
      digest = (v: unknown) => v === '' || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    if (
      !revision(value.revision) ||
      !revision(value.staging) ||
      !digest(value.fingerprint) ||
      !digest(value.wanted) ||
      !time(value.stagedScopes) ||
      !time(value.stagedTasks) ||
      typeof value.enabled !== 'boolean' ||
      !!value.revision !== !!value.fingerprint ||
      !!value.staging !== !!value.wanted
    )
      throw new StateCorrupt()
    return value
  }
  private installation(row: StateRecord | undefined): Installation {
    const value = decode<Installation>(row)
    if (
      typeof value.owner !== 'string' ||
      typeof value.task !== 'string' ||
      !time(value.epoch) ||
      !time(value.until) ||
      !time(value.retryAt)
    )
      throw new StateCorrupt()
    return value
  }
  private async reschedule(
    tx: StateTransaction,
    id: string,
    row: StateRecord,
    task: Task,
    nextAt: number,
  ): Promise<void> {
    const previous = await tx.get(due(id, task.nextAt), true)
    if (previous) await this.remove(tx, previous)
    await this.put(tx, row.key, { ...task, nextAt }, row)
    await this.put(tx, due(id, nextAt), { id })
  }
  private async put(tx: StateTransaction, key: string, payload: unknown, previous?: StateRecord): Promise<void> {
    if (!(await tx.put(record(key, payload), previous?.version ?? null))) throw new StateConflict()
  }
  private async remove(tx: StateTransaction, row: StateRecord): Promise<void> {
    if (!(await tx.remove(row.key, row.version))) throw new StateConflict()
  }
}
