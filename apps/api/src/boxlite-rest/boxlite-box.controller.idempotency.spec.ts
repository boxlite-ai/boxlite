jest.mock('../box/services/box.service', () => ({ BoxService: class {} }))
jest.mock('../auth/combined-auth.guard', () => ({ CombinedAuthGuard: class {} }))
jest.mock('../organization/guards/organization-resource-action.guard', () => ({
  OrganizationResourceActionGuard: class {},
  hasOrganizationResourcePermissions: () => true,
}))

import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxState } from '../box/enums/box-state.enum'
import { Context } from '../common/context/context'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'

const key = '11111111-1111-4111-8111-111111111111'
const auth = { organization: { id: 'org' }, organizationId: 'org', userId: 'owner' }
const box = { id: 'original', name: 'original', state: BoxState.STARTED, labels: {} }

// The real request persistence service is covered separately. This boundary
// fixture models its contract so this regression also runs on the old controller.
function setup() {
  let full = true
  let response: unknown
  let fingerprint: string
  const requests = {
    run: jest.fn(async (_scope, _key, payload, create) => {
      const next = JSON.stringify(payload)
      if (response && next !== fingerprint) throw new Error('different request')
      if (response) return response
      const result = await create(async () => {})
      fingerprint = next
      response = result
      return result
    }),
  }
  const service = {
    create: jest.fn(async () => {
      if (full) throw new BoxCreationLimitExceededError(1, 1)
      full = true
      return box
    }),
  }
  const limits = { resolveMaxCreatedBoxes: jest.fn(async () => 1) }
  const controller = Reflect.construct(BoxliteBoxController, [service, {}, limits, requests]) as BoxliteBoxController
  const call = (image = 'alpine') =>
    controller.createBox(auth as never, { image } as never, Context.user(), {
      headers: { 'idempotency-key': key },
    } as never)
  return {
    call,
    service,
    limits,
    release: () => {
      full = false
    },
  }
}

describe('keyed box creation', () => {
  it('replays success after quota rejection and filling the released slot', async () => {
    const fixture = setup()
    await expect(fixture.call()).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
    fixture.release()
    const first = await fixture.call()
    await expect(fixture.call()).resolves.toEqual(first)
    expect(fixture.service.create).toHaveBeenCalledTimes(2)
    expect(fixture.limits.resolveMaxCreatedBoxes).toHaveBeenCalledTimes(2)
  })

  it('rejects changed payload before another create', async () => {
    const fixture = setup()
    fixture.release()
    await fixture.call()
    await expect(fixture.call('different')).rejects.toThrow('different request')
    expect(fixture.service.create).toHaveBeenCalledTimes(1)
  })
})
