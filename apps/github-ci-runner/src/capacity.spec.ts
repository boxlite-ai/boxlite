/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionJournal, ExecutionScope, ListenerState } from '@boxlite-ai/ci-listener'
import { SqliteStateDatabase } from '@boxlite-ai/ci-listener/sqlite'
import { EnvironmentCapacity } from './capacity'

describe('CI standalone ENV capacity provider', () => {
  it('uses one fixed total across all requested tenants, installations and repositories', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-env-capacity-'))
    const database = new SqliteStateDatabase(directory)
    try {
      const state = new ListenerState(database, 'standalone-capacity')
      const journal = new ExecutionJournal(state)
      await journal.initialize()
      const lease = (await state.acquire('listener', 30000))!
      const provider = new EnvironmentCapacity(1)
      const makeScope = (id: number): ExecutionScope => ({
        binding: 'binding-' + id,
        generation: 1,
        organization: 'tenant-' + id,
        actor: 'owner',
        installation: { id, account: { id, login: 'owner-' + id, type: 'User' } },
        runners: {
          kind: 'repository',
          allowPublic: false,
          repository: { id, name: 'repo', owner: { id, login: 'owner-' + id }, private: true },
        },
      })
      const reserve = async (id: number) => {
        const scope = makeScope(id),
          key = await journal.define(lease, scope)
        const job = { repository: id, job: id, run: id }
        const policy = await provider.resolve({
          scope,
          repository: id,
          job,
          lease,
          signal: new AbortController().signal,
        })
        return journal.reserve(lease, key, job, policy)
      }
      const first = (await reserve(1))!
      expect(first).toBeDefined()
      expect(await reserve(2)).toBeUndefined()
      await journal.advance(lease, first.record.key, first.record.version, { box: { phase: 'absent', id: null } })
      expect(await reserve(2)).toBeDefined()
      expect((await journal.load(lease)).workers.map((worker) => worker.organization)).toEqual(['tenant-2'])
    } finally {
      await database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
