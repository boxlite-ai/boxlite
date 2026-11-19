import { purgeApp } from './lifecycle'
import type { Ctx } from './ctx'
import type { AppRow } from './db'

it('destroys every App Box before deleting a volume shared between its environments', async () => {
  const app = { id: 'app', name: 'demo' } as AppRow
  const consumers = new Set(['box-main', 'box-worker', 'box-staging'])
  const removeVolume = jest.fn(async () => {
    if (consumers.size) throw new Error('Volume is in use')
  })
  const ctx = {
    store: {
      envs: async () => [
        { id: 'main', active_box_id: 'box-main' },
        { id: 'staging', active_box_id: 'box-staging' },
      ],
      deploymentsWhere: async () => [],
      tx: async (work) => work(),
      run: async () => undefined,
      get: async () => app,
      appById: async () => app,
    },
    withPurgeLock: async (_id, work) => work(new AbortController().signal),
    boxlite: {
      deleteBox: async (id) => {
        consumers.delete(id)
      },
    },
    boxes: { list: async () => ['box-main', 'box-worker', 'box-staging'] },
    resources: { deleteVolumes: removeVolume },
    domains: { releaseEnvironment: async () => undefined },
    blobs: { deleteApp: async () => undefined },
  } as unknown as Ctx
  await purgeApp(ctx, app)
  expect(removeVolume).toHaveBeenCalledTimes(2)
  expect(consumers.size).toBe(0)
})
