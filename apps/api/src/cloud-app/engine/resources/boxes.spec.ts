import type { Ctx } from '../ctx'
import type { EnvRow } from '../db'
import { BoxProvisioner } from './boxes'
import type { BoxWaker } from './wake'

test('a lost worker lease stops supervisor polling after waking the Box', async () => {
  const lease = new AbortController()
  const env = { id: 'env1', active_box_id: 'box1', box_url: 'https://box.example.test' } as EnvRow
  const health = jest.fn()
  const ctx = {
    store: { envById: async () => env },
    boxlite: {
      getBox: async () => ({ id: 'box1', status: 'stopped' }),
      startBox: async () => lease.abort(new Error('worker lease lost')),
    },
    supervisor: { health },
    timing: { supervisorReadyMs: 100, pollMs: 1 },
  } as unknown as Ctx
  const waker = { noteWake: () => undefined } as unknown as BoxWaker
  await expect(new BoxProvisioner(ctx, waker).ensureRunning(env.id, () => undefined, lease.signal)).rejects.toThrow(
    'worker lease lost',
  )
  expect(health).not.toHaveBeenCalled()
})
