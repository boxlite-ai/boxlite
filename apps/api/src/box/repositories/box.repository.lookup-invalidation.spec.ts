/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BoxRepository } from './box.repository'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'

describe('BoxRepository organization lookup invalidation', () => {
  function makeRepository() {
    const boxLookupCacheInvalidationService = { invalidate: jest.fn(), invalidateOrgId: jest.fn() }
    const repository = Object.assign(Object.create(BoxRepository.prototype), {
      boxLookupCacheInvalidationService,
    }) as BoxRepository
    return { repository, boxLookupCacheInvalidationService }
  }

  function box(overrides: Record<string, unknown> = {}) {
    return {
      id: 'box-1',
      organizationId: 'org-1',
      name: 'box-name',
      authToken: 'token',
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      ...overrides,
    } as any
  }

  it('invalidates organization lookups after a rename', () => {
    const { repository, boxLookupCacheInvalidationService } = makeRepository()

    ;(repository as any).invalidateLookupCacheOnUpdate(box({ name: 'new-name' }), box())

    expect(boxLookupCacheInvalidationService.invalidateOrgId).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-name', previousName: 'box-name' }),
    )
  })

  it.each([
    ['deletion request', box({ desiredState: BoxDesiredState.DESTROYED })],
    ['destroyed state', box({ state: BoxState.DESTROYED, desiredState: BoxDesiredState.DESTROYED })],
  ])('invalidates organization lookups after %s', (_label, updated) => {
    const { repository, boxLookupCacheInvalidationService } = makeRepository()

    ;(repository as any).invalidateLookupCacheOnUpdate(updated, box())

    expect(boxLookupCacheInvalidationService.invalidateOrgId).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate organization lookups for an ordinary state update', () => {
    const { repository, boxLookupCacheInvalidationService } = makeRepository()

    ;(repository as any).invalidateLookupCacheOnUpdate(box({ state: BoxState.STOPPED }), box())

    expect(boxLookupCacheInvalidationService.invalidateOrgId).not.toHaveBeenCalled()
  })
})
