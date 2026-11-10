/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import { InstallationDirectory, DirectoryBinding, DirectorySource, DiscoverySnapshot, InventoryWake } from './directory'
import { ExecutionScope } from './execution/model'
import { GitHubRequestError } from './github'
import { StateCorrupt } from './state/database'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const binding = (id: number): DirectoryBinding => ({
  binding: 'binding' + id,
  generation: 1,
  organization: 'tenant' + id,
  actor: 'actor' + id,
  installation: { id, account: { id: id + 6, login: 'owner' + id, type: 'User' }, permissions: {}, suspended: false },
  policy: { allowPublic: false, group: 'boxlite-ci-runner' },
})
const scope = (value: DirectoryBinding): ExecutionScope => ({
  binding: value.binding,
  generation: value.generation,
  organization: value.organization,
  actor: value.actor,
  installation: { id: value.installation.id, account: { ...value.installation.account } },
  runners: {
    kind: 'repository',
    repository: {
      id: value.installation.id + 100,
      name: 'repo',
      owner: { id: value.installation.account.id, login: value.installation.account.login },
      private: true,
    },
    allowPublic: false,
  },
})

describe('CI installation directory protocol', () => {
  let directory: InstallationDirectory, source: jest.Mocked<DirectorySource>, wakes: InventoryWake[]
  const owner = { namespace: 'app', owner: 'owner', epoch: 1 },
    external = new AbortController()
  const step = () => directory.step(owner, { refresh: false, wakes }, external.signal)
  async function until(done: (view: DiscoverySnapshot) => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const view = step()
      if (done(view)) return view
      await tick()
    }
    throw Error('Expected directory transition was not observed')
  }
  beforeEach(() => {
    wakes = []
    source = {
      index: jest.fn<ReturnType<DirectorySource['index']>, Parameters<DirectorySource['index']>>(async () => [
        binding(1),
      ]),
      load: jest.fn<ReturnType<DirectorySource['load']>, Parameters<DirectorySource['load']>>(async (item) => [
        scope(item),
      ]),
      report: jest.fn(),
    }
    directory = new InstallationDirectory(source)
  })
  afterEach(async () => {
    await directory.close()
    jest.restoreAllMocks()
  })
  it.each([
    { key: 'wake/1', version: '', installationId: 1, accountId: 7, repositoryId: 0 },
    { key: 'wake/1', version: 'version', installationId: -1, accountId: 7, repositoryId: 0 },
    { key: 'wake/1', version: 'version', installationId: 1, accountId: 0, repositoryId: 0 },
    { key: 'wake/1', version: 'version', installationId: 1, accountId: 7, repositoryId: -1 },
  ])('rejects malformed wake metadata before discovery: %p', (value) => {
    wakes = [
      {
        ...value,
        key: `wake/${value.installationId}/${value.repositoryId}`,
        version: value.version ? randomUUID() : '',
      },
    ]
    expect(step).toThrow(StateCorrupt)
    expect(source.index).not.toHaveBeenCalled()
  })
  it.each(['generation', 'policy', 'excess'])(
    'rejects invalid installation indexes atomically: %s',
    async (scenario) => {
      source.index.mockResolvedValue(
        scenario === 'excess'
          ? Array.from({ length: 10001 }, (_, id) => binding(id + 1))
          : [
              {
                ...binding(1),
                ...(scenario === 'generation'
                  ? { generation: 0 }
                  : { policy: { group: 'ci', allowPublic: null as any } }),
              },
            ],
      )
      if (scenario === 'excess') {
        await until(() => source.report.mock.calls.length > 0)
        expect(step().ready).toBe(false)
      } else await expect(until((view) => view.ready)).rejects.toBeInstanceOf(StateCorrupt)
      expect(source.load).not.toHaveBeenCalled()
    },
  )
  it('rejects a wake for the wrong owner after directory publication', async () => {
    await until((view) => view.ready)
    wakes = [{ key: 'wake/1/0', version: randomUUID(), installationId: 1, accountId: 999, repositoryId: 0 }]
    expect(step).toThrow(StateCorrupt)
  })
  it('publishes one installation while a different catalog remains in flight', async () => {
    const blocked = deferred()
    source.index.mockResolvedValue([binding(1), binding(2)])
    source.load.mockImplementation(async (item) => {
      if (item.installation.id === 2) await blocked.promise
      return [scope(item)]
    })
    try {
      const view = await until(() => source.load.mock.calls.length === 2)
      expect(view.scopes.map((item) => item.installation.id)).toEqual([1])
      expect(view.pending).toBe(true)
      expect(source.report).not.toHaveBeenCalled()
    } finally {
      blocked.resolve()
    }
    expect((await until((view) => view.ready)).scopes).toHaveLength(2)
  })
  it('demand scheduling prioritizes a cold installation with a durable hint', async () => {
    source.index.mockResolvedValue(Array.from({ length: 200 }, (_, i) => binding(i + 1)))
    wakes = [{ key: 'wake/200/0', version: randomUUID(), installationId: 200, accountId: 206, repositoryId: 0 }]
    await until(() => source.load.mock.calls.length > 0)
    expect(source.load.mock.calls[0][0].installation.id).toBe(200)
  })
  it('demand scheduling reserves a background turn after three hinted catalogs', async () => {
    source.index.mockResolvedValue(Array.from({ length: 8 }, (_, i) => binding(i + 1)))
    wakes = [5, 6, 7, 8].map((id) => ({
      key: `wake/${id}/0`,
      version: randomUUID(),
      installationId: id,
      accountId: id + 6,
      repositoryId: 0,
    }))
    await until(() => source.load.mock.calls.length >= 4)
    const order = source.load.mock.calls.slice(0, 4).map(([item]) => item.installation.id)
    expect(order.slice(0, 3).every((id) => id >= 5)).toBe(true)
    expect(order[3]).toBeLessThan(5)
  })
  it('demand scheduling advances a catalog despite continuously newer inventory hints', async () => {
    source.index.mockResolvedValue([binding(1), binding(2)])
    const hint = { key: 'wake/1/0', installationId: 1, accountId: 7, repositoryId: 0 }
    for (let i = 0; i < 30 && source.load.mock.calls.length === 0; i++) {
      wakes = [{ ...hint, version: randomUUID() }]
      step()
      await tick()
    }
    expect(source.load.mock.calls.length).toBeGreaterThan(0)
  })
  it('keeps a newer wake pending when an older in-flight snapshot completes', async () => {
    const first = deferred(),
      second = deferred()
    const original = { key: 'wake/1/0', version: randomUUID(), installationId: 1, accountId: 7, repositoryId: 0 }
    wakes = [original]
    source.load
      .mockImplementationOnce(async (item) => {
        await first.promise
        return [scope(item)]
      })
      .mockImplementationOnce(async (item) => {
        await second.promise
        return [scope(item)]
      })
    try {
      await until(() => source.load.mock.calls.length === 1)
      wakes = [{ ...original, version: randomUUID() }]
      step()
      first.resolve()
      const before = await until(() => source.load.mock.calls.length === 2)
      expect(before.completed).toEqual([])
      second.resolve()
      const after = await until((view) => view.ready)
      expect(after.completed).toEqual(wakes)
      expect(step().completed).toEqual(wakes)
      wakes = []
      expect(step().completed).toEqual([])
    } finally {
      first.resolve()
      second.resolve()
    }
  })
  it('does not let a new delivery or periodic refresh bypass a server retry deadline', async () => {
    const now = 1800000000000,
      clock = jest.spyOn(Date, 'now').mockReturnValue(now)
    source.index.mockResolvedValue([binding(1), binding(2)])
    source.load.mockImplementation(async (item) => {
      if (item.installation.id === 1 && Date.now() < now + 600000)
        throw new GitHubRequestError(429, false, now + 600000)
      return [scope(item)]
    })
    const view = await until((view) => view.scopes.length === 1 && source.report.mock.calls.length === 1)
    expect(view.scopes[0].installation.id).toBe(2)
    wakes = [{ key: 'wake/1/0', version: randomUUID(), installationId: 1, accountId: 7, repositoryId: 0 }]
    directory.step(owner, { refresh: true, wakes }, external.signal)
    for (let i = 0; i < 10; i++) {
      step()
      await tick()
    }
    expect(source.load.mock.calls.filter(([item]) => item.installation.id === 1)).toHaveLength(1)
    clock.mockReturnValue(now + 600001)
    expect((await until((view) => view.ready)).scopes).toHaveLength(2)
  })
  it('withholds admission after a global index failure and acknowledges removal only after a complete retry', async () => {
    const now = 1800000000000,
      clock = jest.spyOn(Date, 'now').mockReturnValue(now)
    await until((view) => view.ready)
    wakes = [{ key: 'wake/1/0', version: randomUUID(), installationId: 1, accountId: 7, repositoryId: 0 }]
    source.index.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce([])
    directory.step(owner, { refresh: true, wakes }, external.signal)
    const failed = await until(() => source.report.mock.calls.length === 1)
    expect(failed.scopes).toEqual([])
    expect(failed.completed).toEqual([])
    clock.mockReturnValue(now + 60001)
    const removed = await until((view) => view.ready)
    expect(removed.scopes).toEqual([])
    expect(removed.completed).toEqual(wakes)
  })
  it('copies index inputs and rejects a catalog that changes its original actor', async () => {
    const supplied = binding(1),
      blocked = deferred()
    source.index.mockResolvedValue([supplied])
    source.load.mockImplementation(async (item) => {
      await blocked.promise
      item.actor = 'injected'
      return [scope(item)]
    })
    try {
      await until(() => source.load.mock.calls.length === 1)
      supplied.actor = 'changed-after-index'
      expect(source.load.mock.calls[0][0].actor).toBe('actor1')
      blocked.resolve()
      const rejected = await until(() => source.report.mock.calls.length > 0)
      expect(rejected.scopes).toEqual([])
      expect(source.report.mock.calls[0][0]).toBeInstanceOf(StateCorrupt)
    } finally {
      blocked.resolve()
    }
  })
  it('discards late catalog output after the original execution epoch changes', async () => {
    const blocked = deferred(),
      next = { ...owner, owner: 'replacement', epoch: 2 }
    source.index.mockResolvedValueOnce([binding(1)]).mockResolvedValue([])
    source.load.mockImplementation(async (item) => {
      await blocked.promise
      return [scope(item)]
    })
    try {
      await until(() => source.load.mock.calls.length === 1)
      expect(directory.step(next, { refresh: false, wakes: [] }, external.signal).scopes).toEqual([])
      blocked.resolve()
      let view = directory.step(next, { refresh: false, wakes: [] }, external.signal)
      for (let i = 0; i < 200 && !view.ready; i++) {
        await tick()
        view = directory.step(next, { refresh: false, wakes: [] }, external.signal)
      }
      expect(view.ready).toBe(true)
      expect(view.scopes).toEqual([])
      expect(source.load).toHaveBeenCalledTimes(1)
    } finally {
      blocked.resolve()
    }
  })
  it('bounds the combined repository cache while retaining an independent healthy installation', async () => {
    const bindings = [binding(1), binding(2)].map((value) => ({
      ...value,
      installation: {
        ...value.installation,
        account: { ...value.installation.account, type: 'Organization' as const },
      },
    }))
    source.index.mockResolvedValue(bindings)
    source.load.mockImplementation(async (item) => [
      {
        ...scope(item),
        runners: {
          kind: 'organization',
          account: item.installation.account,
          group: item.installation.id + 90,
          repositories: Array.from({ length: 50001 }, (_, i) => item.installation.id * 100000 + i),
          allowPublic: false,
        },
      },
    ])
    const view = await until(() => source.report.mock.calls.length > 0)
    expect(view.scopes.map((item) => item.installation.id)).toEqual([1])
    expect(String(source.report.mock.calls[0][0])).toContain('capacity exceeded')
  })
  it('rejects duplicate installation identities instead of publishing a partial index', async () => {
    source.index.mockResolvedValue([binding(1), binding(1)])
    await expect(until((view) => view.ready)).rejects.toBeInstanceOf(StateCorrupt)
    expect(source.load).not.toHaveBeenCalled()
  })
  it('cancels and awaits its active task during shutdown', async () => {
    const blocked = deferred()
    let finished = false
    source.load.mockImplementation(async (item, _lease, signal) => {
      signal.addEventListener('abort', blocked.resolve, { once: true })
      await blocked.promise
      finished = true
      return [scope(item)]
    })
    await until(() => source.load.mock.calls.length > 0)
    await directory.close()
    expect(finished).toBe(true)
    expect(() => step()).toThrow('closed')
  })
})
