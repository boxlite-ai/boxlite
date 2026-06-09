/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../exceptions/bad-request.exception'
import { BoxliteBoxController } from './boxlite-box.controller'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

describe('BoxliteBoxController', () => {
  function createController() {
    const sandboxService = {
      createFromTemplate: jest.fn(),
    }
    const sandboxStateWaiter = {
      waitForStarted: jest.fn(),
    }

    return {
      controller: new BoxliteBoxController(sandboxService as any, sandboxStateWaiter as any),
      sandboxService,
    }
  }

  it('rejects unsupported REST images with the allowed agent-ready image list', async () => {
    const { controller, sandboxService } = createController()
    const create = () => controller.createBox({ organization: { id: 'org-123' } } as any, { image: 'node:22' } as any)

    await expect(create()).rejects.toThrow(BadRequestError)
    await expect(create()).rejects.toThrow('Allowed images: boxlite/base, boxlite/python, boxlite/node')

    expect(sandboxService.createFromTemplate).not.toHaveBeenCalled()
  })
})
