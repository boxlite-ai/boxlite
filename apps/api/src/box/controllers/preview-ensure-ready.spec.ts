/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException, RequestTimeoutException } from '@nestjs/common'
import { PreviewController } from './preview.controller'

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

const BOX = { id: 'box-uuid', organizationId: 'org-1' }
const ORG = { id: 'org-1', suspended: false }

function makeHarness() {
  const boxService = { findOne: jest.fn().mockResolvedValue(BOX) }
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
