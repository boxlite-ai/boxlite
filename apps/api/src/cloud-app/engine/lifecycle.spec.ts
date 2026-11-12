import { purgeApp } from './lifecycle'
import type { Ctx } from './ctx'
import type { AppRow } from './db'

it('destroys every App Box before deleting a volume shared between its environments', async () => {
  const consumers = new Set(['box-main', 'box-staging'])
  const removeVolume = jest.fn(async () => {
    if (consumers.size) throw new Error('Volume is in use')
  })
  const ctx = {
    store: {
      envs: async () => [
        { id: 'main', box_id: 'box-main' },
        { id: 'staging', box_id: 'box-staging' },
      ],
      deploymentsWhere: async () => [],
      tx: async (work) => work(),
      run: async () => undefined,
    },
    boxlite: {
      deleteBox: async (id) => {
        consumers.delete(id)
      },
    },
    resources: { deleteVolumes: removeVolume },
    domains: { releaseEnvironment: async () => undefined },
    blobs: { deleteApp: async () => undefined },
  } as unknown as Ctx
  await purgeApp(ctx, { id: 'app', name: 'demo' } as AppRow)
  expect(removeVolume).toHaveBeenCalledTimes(2)
  expect(consumers.size).toBe(0)
})
