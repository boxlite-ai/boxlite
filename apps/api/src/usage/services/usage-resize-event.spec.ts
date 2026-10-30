import { Box } from '../../box/entities/box.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { UsageService } from './usage.service'

describe('Resize billing event ordering', () => {
  it.each([BoxState.STOPPING, BoxState.STOPPED, BoxState.ERROR, BoxState.ARCHIVED, BoxState.DESTROYED])(
    'ignores a delayed %s event after the box has resumed and resized',
    async (state) => {
      const current = Object.assign(new Box('test'), { state: BoxState.STARTED, cpu: 4, mem: 2 })
      const old = Object.assign(new Box('test'), { ...current, state, cpu: 1, mem: 1 })
      const period = { boxId: current.id, cpu: 4, mem: 2, endAt: null }
      const save = jest.fn(async (row) => row)
      const manager = { findOne: jest.fn(async (entity) => (entity === Box ? current : period)), save }
      const periods = {
        findOne: jest.fn(async () => period),
        save,
        manager: { transaction: async (operation) => operation(manager) },
      }
      const locks = {
        waitForLease: jest.fn(async () => ({ signal: new AbortController().signal, release: async () => {} })),
      }
      const usage = new UsageService(periods as never, locks as never, {} as never, {} as never, {} as never)
      await usage.handleBoxStateUpdate(new BoxStateUpdatedEvent(old, BoxState.STARTED, state))
      expect(save).not.toHaveBeenCalled()
      expect(period.endAt).toBeNull()
    },
  )

  it('opens from persisted resources instead of a delayed STARTED event snapshot', async () => {
    const old = Object.assign(new Box('test'), { state: BoxState.STARTED, cpu: 1, mem: 1 })
    const persisted = Object.assign(new Box('test'), { ...old, cpu: 4, mem: 2 })
    const written: BoxUsagePeriod[] = []
    const manager = {
      findOne: jest.fn(async (entity) => (entity === Box ? persisted : null)),
      save: jest.fn(async (period: BoxUsagePeriod) => {
        written.push(period)
        return period
      }),
    }
    const periods = { manager: { transaction: async (operation) => operation(manager) } }
    const locks = {
      waitForLease: jest.fn(async () => ({ signal: new AbortController().signal, release: async () => {} })),
    }
    const usage = new UsageService(periods as never, locks as never, {} as never, {} as never, {} as never)
    await usage.handleBoxStateUpdate(new BoxStateUpdatedEvent(old, BoxState.STARTING, BoxState.STARTED))
    expect(written).toEqual([expect.objectContaining({ cpu: 4, mem: 2, endAt: null })])
  })
})
