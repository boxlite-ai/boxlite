/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { setTimeout as delay } from 'node:timers/promises'
import {
  ConfirmedWorkerAbsent,
  ConfirmedWorkerCreationRejected,
  decodeScope,
  ExecutionJournal,
  ExecutionLease,
  ExecutionScope,
  jitFileArchive,
  ListenerState,
  Json,
  WorkerExecutor,
  WorkerLaunch,
  WorkerState,
  scopeKey,
  validateWorkerResources,
} from '@boxlite-ai/ci-listener'
import { BoxLiteHttp, BoxLiteRequestError } from './boxlite-http'
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** An original-ID ledger survives boot failures; unknown creates never adopt same-name resources. */
export class BoxLiteWorkers {
  private constructor(
    private readonly state: ListenerState,
    readonly http: BoxLiteHttp,
  ) {
    Object.freeze(this)
  }
  static async connect(
    state: ListenerState,
    endpoint: string,
    key: string,
    roots: { key: string; payload: Json }[] = [],
  ): Promise<BoxLiteWorkers> {
    const http = await BoxLiteHttp.connect(endpoint, key),
      root = { endpoint: http.root, principal: { ...http.principal } }
    await new ExecutionJournal(state).initialize([{ key: 'backend/boxlite', payload: root }, ...roots])
    const result = new BoxLiteWorkers(state, http)
    await result.identity()
    return result
  }
  private async identity(): Promise<void> {
    const [backend] = await this.state.read(['backend/boxlite']),
      principal = this.http.principal
    if (
      !backend ||
      !object(backend.payload) ||
      backend.payload.endpoint !== this.http.root ||
      !object(backend.payload.principal) ||
      backend.payload.principal.sub !== principal.sub ||
      backend.payload.principal.path_prefix !== principal.path_prefix ||
      backend.payload.principal.principal_type !== principal.principal_type
    )
      throw new Error('Original BoxLite backend identity unavailable')
  }
  bind(
    scope: ExecutionScope,
    lease: ExecutionLease,
    admit: () => Promise<void>,
  ): WorkerExecutor & {
    rejectUndispatchedCreate(name: string, effect: string): Promise<never>
  } {
    scope = decodeScope(scope)
    lease = { ...lease }
    if (scope.actor !== this.http.principal.sub || scope.organization !== this.http.principal.path_prefix)
      throw new Error('Original BoxLite execution identity does not match scope')
    const key = scopeKey(scope),
      journal = new ExecutionJournal(this.state)
    const allocation = async (name: string) => {
      if (!/^ci-jit-[a-f0-9]{32}$/.test(name)) throw new Error('Original CI allocation name required')
      await this.identity()
      const allocation = await journal.allocation(lease, 'worker/' + name.slice(7))
      if (!allocation || allocation.value.scope !== key || allocation.value.name !== name)
        throw new Error('Original CI allocation unavailable')
      return allocation
    }
    const owned = async (name: string) => {
      await this.http.verify()
      return allocation(name)
    }
    const creating = (row: Awaited<ReturnType<typeof allocation>>, effect: string) => {
      const value = row.value
      if (
        value.box.phase !== 'requested' ||
        value.box.id !== null ||
        value.runner.phase !== 'none' ||
        value.delivery !== 'none' ||
        value.effect?.kind !== 'box-create' ||
        value.effect.id !== effect
      )
        throw new Error('Original Box create intent changed')
    }
    const rejectUndispatchedCreate = async (name: string, effect: string): Promise<never> => {
      const rejected = new ConfirmedWorkerCreationRejected(effect),
        row = await allocation(name)
      creating(row, effect)
      const ledgerKey = 'box-rest/' + name,
        [prior] = await this.state.read([ledgerKey], lease)
      if (prior) {
        if (
          !object(prior.payload) ||
          prior.payload.scope !== key ||
          prior.payload.name !== name ||
          prior.payload.box !== null ||
          prior.payload.rejectedCreationEffect !== effect ||
          prior.payload.dispatchEffect !== undefined
        )
          throw new Error('Original CI create may already have dispatched')
      } else {
        // Rejection and dispatch compete for one key. A missing ID alone proves nothing.
        await this.state.commit(
          lease,
          [
            {
              key: ledgerKey,
              expected: null,
              payload: { scope: key, name, box: null, rejectedCreationEffect: effect },
            },
          ],
          [{ key: row.record.key, version: row.record.version }],
        )
      }
      throw rejected
    }
    const admission = async (name: string) => {
      await admit()
      const row = await owned(name)
      if (row.value.closing) throw new Error('CI allocation is closing')
      return row
    }
    const ledger = async (name: string) => {
      const row = await allocation(name)
      const [record] = await this.state.read(['box-rest/' + name], lease)
      if (!record || !object(record.payload) || record.payload.scope !== key || record.payload.name !== name)
        throw new Error('Original CI Box ID is not durably known')
      if (
        record.payload.box === null &&
        typeof record.payload.rejectedCreationEffect === 'string' &&
        record.payload.dispatchEffect === undefined
      ) {
        creating(row, record.payload.rejectedCreationEffect)
        throw new ConfirmedWorkerCreationRejected(record.payload.rejectedCreationEffect)
      }
      if (!identifier(record.payload.box)) throw new Error('Original CI Box ID is not durably known')
      const current = await owned(name)
      if (current.value.box.id !== null && current.value.box.id !== record.payload.box)
        throw new Error('Original CI Box ledger identity changed')
      return record.payload.box
    }
    const observe = (value: unknown, name: string, id?: string): WorkerState => {
      if (
        !object(value) ||
        !identifier(value.box_id) ||
        value.name !== name ||
        (id !== undefined && value.box_id !== id) ||
        typeof value.status !== 'string' ||
        !['configured', 'created', 'starting', 'running', 'stopping', 'stopped', 'error', 'unknown'].includes(
          value.status,
        )
      )
        throw new Error('Original CI Box identity or state changed')
      if (value.exit_code !== undefined && value.exit_code !== null && !Number.isSafeInteger(value.exit_code))
        throw new Error('Invalid original CI Box exit code')
      return {
        box_id: value.box_id,
        status: value.status === 'configured' ? 'starting' : value.status,
        ...(value.exit_code === undefined ? {} : { exit_code: value.exit_code as number | null }),
      }
    }
    const get = async (name: string): Promise<WorkerState> => {
      const original = await ledger(name)
      try {
        return observe(await this.http.request('GET', '/boxes/' + original), name, original)
      } catch (error) {
        if (!(error instanceof BoxLiteRequestError) || error.status !== 404) throw error
        const seen = new Set<string>(),
          tokens = new Set<string>()
        let token: string | undefined
        for (let page = 0; page < 1000; page++) {
          const value = await this.http.request(
            'GET',
            '/boxes?pageSize=100' + (token ? '&pageToken=' + encodeURIComponent(token) : ''),
          )
          if (!object(value) || !Array.isArray(value.boxes)) throw new Error('Incomplete BoxLite inventory')
          for (const box of value.boxes) {
            if (!object(box) || !identifier(box.box_id) || seen.has(box.box_id))
              throw new Error('Invalid BoxLite inventory')
            seen.add(box.box_id)
            if (box.box_id === original) throw new Error('Original CI Box is still present')
          }
          if (value.next_page_token === undefined) {
            await owned(name)
            throw new ConfirmedWorkerAbsent()
          }
          if (typeof value.next_page_token !== 'string' || !value.next_page_token || tokens.has(value.next_page_token))
            throw new Error('Incomplete BoxLite inventory')
          token = value.next_page_token
          tokens.add(token)
        }
        throw new Error('BoxLite inventory limit exceeded')
      }
    }
    return {
      rejectUndispatchedCreate,
      create: async (launch: WorkerLaunch) => {
        launch = { ...launch, entrypoint: [...launch.entrypoint] }
        validateWorkerResources(launch)
        const original = await allocation(launch.name)
        let row: typeof original
        try {
          row = await admission(launch.name)
        } catch (error) {
          if (original.value.box.phase === 'requested' && original.value.effect?.kind === 'box-create')
            return rejectUndispatchedCreate(launch.name, original.value.effect.id)
          throw error
        }
        if (original.value.box.phase !== 'requested' || original.value.effect?.kind !== 'box-create')
          throw new Error('Box create intent missing')
        const effect = original.value.effect.id
        creating(row, effect)
        const [dispatch] = await this.state.commit(
          lease,
          [
            {
              key: 'box-rest/' + launch.name,
              expected: null,
              payload: { scope: key, name: launch.name, box: null, dispatchEffect: effect },
            },
          ],
          [{ key: row.record.key, version: row.record.version }],
        )
        const box = observe(
          await this.http.request('POST', '/boxes', {
            name: launch.name,
            image: launch.image,
            cpus: launch.cpus,
            memory_mib: launch.memoryMiB,
            disk_size_gb: launch.diskGiB ?? 10,
            user: 'runner',
            working_dir: '/home/runner',
            entrypoint: launch.entrypoint,
            cmd: [],
            auto_stop: 0,
            auto_resume: false,
          }),
          launch.name,
        )
        await this.state.commit(lease, [
          {
            key: 'box-rest/' + launch.name,
            expected: dispatch.version,
            payload: { scope: key, name: launch.name, box: box.box_id },
          },
        ])
        // Cloud create may already boot; local REST may return configured. Observe, do not assume either.
        if (['starting', 'created'].includes(box.status)) {
          await admission(launch.name)
          try {
            await this.http.request('POST', '/boxes/' + box.box_id + '/start')
          } catch (error) {
            if (!(error instanceof BoxLiteRequestError) || error.status !== 409) throw error
          }
          const deadline = Date.now() + 120000
          for (;;) {
            const current = await get(launch.name)
            if (['running', 'stopped', 'error'].includes(current.status)) return current
            if (Date.now() >= deadline) throw new Error('Original CI Box boot is pending')
            await delay(1000)
          }
        }
        return get(launch.name)
      },
      get,
      stop: async (name) => {
        const original = await ledger(name),
          row = await owned(name)
        if (row.value.effect?.kind !== 'box-stop') throw new Error('Box stop intent missing')
        await this.http.request('POST', '/boxes/' + original + '/stop')
      },
      remove: async (name) => {
        const original = await ledger(name),
          box = await get(name),
          row = await owned(name)
        if (row.value.effect?.kind !== 'box-remove' || !['stopped', 'error'].includes(box.status))
          throw new Error('CI Box must stop before deletion')
        await this.http.request('DELETE', '/boxes/' + original)
      },
      deliverJit: async (name, configuration, signal) => {
        const original = await ledger(name)
        for (const [file, content] of [
          ['.boxlite-jitconfig', configuration],
          ['.boxlite-jitconfig.ready', 'ready'],
        ] as const) {
          signal?.throwIfAborted()
          const row = await admission(name)
          if (
            row.value.delivery !== 'requested' ||
            row.value.effect?.kind !== 'jit-deliver' ||
            row.value.box.id !== original
          )
            throw new Error('JIT delivery intent missing')
          await this.http.request(
            'PUT',
            '/boxes/' + original + '/files?path=%2Fhome%2Frunner',
            jitFileArchive(file, content),
            signal,
          )
        }
      },
    }
  }
}
