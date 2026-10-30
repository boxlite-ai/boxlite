import { Box } from './box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

describe('Cloud resize admission invariant', () => {
  it('keeps lifecycle work fenced while a running box owns a resize job', () => {
    const box = Object.assign(new Box('test'), {
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
      resizeJobId: '00000000-0000-4000-8000-000000000001',
    })
    box.enforceInvariants()
    expect(box.pending).toBe(true)
  })

  it('still clears pending for ordinary completed starts', () => {
    const box = Object.assign(new Box('test'), {
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    box.enforceInvariants()
    expect(box.pending).toBe(false)
  })
})
