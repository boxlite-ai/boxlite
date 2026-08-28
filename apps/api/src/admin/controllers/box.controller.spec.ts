/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AdminBoxController } from './box.controller'

describe('AdminBoxController recovery', () => {
  it('uses the admin-only recovery path that bypasses Commerce admission', async () => {
    const organization = { id: 'org-1' }
    const recoveredBox = { id: 'box-1' }
    const boxService = {
      recover: jest.fn().mockResolvedValue(recoveredBox),
      recoverAsAdmin: jest.fn().mockResolvedValue(recoveredBox),
      toBoxDto: jest.fn().mockResolvedValue(recoveredBox),
    }
    const organizationService = { findByBoxId: jest.fn().mockResolvedValue(organization) }
    const controller = new AdminBoxController(boxService as never, organizationService as never)

    await controller.recoverBox('box-1')

    expect(boxService.recoverAsAdmin).toHaveBeenCalledWith('box-1', organization)
    expect(boxService.recover).not.toHaveBeenCalled()
  })
})
