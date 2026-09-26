/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, NotFoundException, RequestTimeoutException } from '@nestjs/common'
import { PreviewController } from './preview.controller'
import { BoxState } from '../enums/box-state.enum'

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

// A box the endpoint is allowed to wake: stopped, and opted into autoResume.
const BOX = { id: 'box-uuid', organizationId: 'org-1', state: BoxState.STOPPED, autoResume: true }
const ORG = { id: 'org-1', suspended: false }

function makeHarness(box: Record<string, unknown> = BOX) {
  const boxService = { findOne: jest.fn().mockResolvedValue(box) }
  const autoResume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
  const organizationService = { findOne: jest.fn().mockResolvedValue(ORG) }
  const controller = new PreviewController(
    {} as never, // redis, unused by this route
    boxService as never,
    {} as never, // organizationUserService, unused by this route
    autoResume as never,
    organizationService as never,
  )
  return { controller, boxService, autoResume, organizationService }
}

describe('PreviewController.ensureBoxReady', () => {
  beforeEach(() => jest.clearAllMocks())

  it('resolves the organization from the box row rather than the caller', async () => {
    // The point of the endpoint: the proxy has a box-scoped identity and no
    // organization, so the organization has to come from the box itself.
    const { controller, boxService, autoResume, organizationService } = makeHarness()

    await expect(controller.ensureBoxReady('public-box')).resolves.toBeUndefined()

    expect(boxService.findOne).toHaveBeenCalledWith('public-box')
    expect(organizationService.findOne).toHaveBeenCalledWith('org-1')
    // Resumes by the box's real id, not the caller-supplied name.
    expect(autoResume.ensureReady).toHaveBeenCalledWith('box-uuid', ORG)
  })

  it('404s a box whose organization is gone instead of waiting out the resume', async () => {
    // A retry cannot fix this, and reporting it as a timeout would cost the
    // caller the full resume window to learn nothing.
    const { controller, autoResume, organizationService } = makeHarness()
    organizationService.findOne.mockResolvedValue(null)

    await expect(controller.ensureBoxReady('public-box')).rejects.toBeInstanceOf(NotFoundException)
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
  })

  it('propagates a resume timeout to the caller', async () => {
    // The proxy decides how to render this (a hold, a 503 with Retry-After);
    // the endpoint must not swallow it into a success.
    const { controller, autoResume } = makeHarness()
    const timeout = new RequestTimeoutException('Timed out waiting to resume box box-uuid')
    autoResume.ensureReady.mockRejectedValue(timeout)

    await expect(controller.ensureBoxReady('public-box')).rejects.toBe(timeout)
  })

  it('surfaces a missing box from the lookup', async () => {
    const { controller, boxService, autoResume } = makeHarness()
    const missing = new NotFoundException('Box not found')
    boxService.findOne.mockRejectedValue(missing)

    await expect(controller.ensureBoxReady('ghost')).rejects.toBe(missing)
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
  })
})

describe('PreviewController.ensureBoxReady — who may be woken', () => {
  beforeEach(() => jest.clearAllMocks())

  it('refuses to wake a box that opted out of autoResume', async () => {
    // `auto_resume: false` is one of the two switches an owner has against a
    // published URL starting their box on someone else's request, so inbound
    // traffic must not override it. The tunnel-open route has always honoured
    // it; this route drifting from that is what let a preview URL start a box
    // whose owner had opted out.
    const { controller, autoResume, organizationService } = makeHarness({ ...BOX, autoResume: false })

    await expect(controller.ensureBoxReady('public-box')).rejects.toBeInstanceOf(ConflictException)
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
    // Rejected ahead of the organization lookup: one query, not two.
    expect(organizationService.findOne).not.toHaveBeenCalled()
  })

  it.each([BoxState.ERROR, BoxState.ARCHIVED])(
    'refuses %s immediately instead of holding the request for the resume window',
    async (state) => {
      // These never reach STARTED on their own, so waiting out the window
      // would cost the caller 30s to learn what the box row already says.
      const { controller, autoResume } = makeHarness({ ...BOX, state })

      await expect(controller.ensureBoxReady('public-box')).rejects.toBeInstanceOf(ConflictException)
      expect(autoResume.ensureReady).not.toHaveBeenCalled()
    },
  )

  it('still serves a running box whatever its autoResume setting', async () => {
    // A running box is ready by definition; the opt-out governs starting one,
    // not reaching one that is already up.
    const { controller, autoResume } = makeHarness({ ...BOX, state: BoxState.STARTED, autoResume: false })

    await expect(controller.ensureBoxReady('public-box')).resolves.toBeUndefined()
    expect(autoResume.ensureReady).toHaveBeenCalledWith('box-uuid', ORG)
  })
})
