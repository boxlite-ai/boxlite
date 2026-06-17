import { describe, expect, it } from 'vitest'

import { getBoxDisplayName, getBoxRouteId } from './box-identity'

describe('box identity helpers', () => {
  it('uses id as the only route identity', () => {
    expect(getBoxRouteId({ id: 'Srv123456789', boxId: 'legacy-box' } as any)).toBe('Srv123456789')
  })

  it('uses id as the display fallback when the name is just the id', () => {
    expect(getBoxDisplayName({ id: 'Srv123456789', name: 'Srv123456789' } as any)).toBe('Srv123456789')
  })
})
