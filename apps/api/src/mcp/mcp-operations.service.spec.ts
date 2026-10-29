/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { NotFoundException } from '@nestjs/common'
import { McpOperationsService } from './mcp-operations.service'

describe('McpOperationsService retained results', () => {
  it('retains create-operation status after its Box is deleted', async () => {
    const operation = {
      id: 'op',
      tool: 'create_box',
      state: 'succeeded',
      box_id: 'deleted-box',
      expires_at: new Date(),
    }
    const service = new McpOperationsService(
      { read: jest.fn().mockResolvedValue(operation) } as never,
      {} as never,
      {} as never,
      { findOneByIdOrName: jest.fn().mockRejectedValue(new NotFoundException('Box not found')) } as never,
      {} as never,
      {} as never,
    )
    await expect(service.read({ organizationId: 'org', userId: 'creator' } as never, 'op')).resolves.toMatchObject({
      operation_id: 'op',
      state: 'succeeded',
      box_id: 'deleted-box',
      box: null,
    })
  })
})
