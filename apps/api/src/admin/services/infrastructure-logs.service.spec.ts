/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InfrastructureLogsService } from './infrastructure-logs.service'

describe('InfrastructureLogsService', () => {
  it('queries only the configured log group and safely quotes literal search text', async () => {
    const send = jest.fn().mockResolvedValue({
      events: [
        {
          eventId: 'event-1',
          logStreamName: 'i-runner-1/setup',
          message: 'bootstrap failed',
          timestamp: Date.parse('2026-08-14T00:00:00.000Z'),
        },
      ],
      nextToken: 'next-page',
    })
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'infrastructureLogs.region': 'ap-southeast-1',
          'infrastructureLogs.logGroupName': '/boxlite/dev/runner-infrastructure',
        }
        return values[key]
      }),
    }
    const service = new InfrastructureLogsService(config as any, { send } as any)

    const response = await service.query({
      from: '2026-08-13T23:00:00.000Z',
      to: '2026-08-14T01:00:00.000Z',
      search: 'failed "quoted" \\ value',
      limit: 50,
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].input).toEqual(
      expect.objectContaining({
        logGroupName: '/boxlite/dev/runner-infrastructure',
        filterPattern: '"failed \\"quoted\\" \\\\ value"',
        limit: 50,
      }),
    )
    expect(response).toEqual({
      items: [
        expect.objectContaining({
          body: 'bootstrap failed',
          serviceName: 'runner-infrastructure',
          resourceAttributes: expect.objectContaining({
            'aws.log_group': '/boxlite/dev/runner-infrastructure',
            'aws.log_stream': 'i-runner-1/setup',
          }),
        }),
      ],
      nextToken: 'next-page',
    })
  })

  it('fails closed when the allowlisted log group is not configured', async () => {
    const service = new InfrastructureLogsService({ get: jest.fn() } as any, { send: jest.fn() } as any)

    await expect(
      service.query({
        from: '2026-08-13T23:00:00.000Z',
        to: '2026-08-14T01:00:00.000Z',
        limit: 50,
      }),
    ).rejects.toThrow('Infrastructure log search is not configured')
  })

  it('rejects control characters instead of emitting an unsafe filter pattern', async () => {
    const send = jest.fn()
    const config = {
      get: jest.fn((key: string) =>
        key === 'infrastructureLogs.runnerLogGroupName' ? '/boxlite/dev/runner-infrastructure' : undefined,
      ),
    }
    const service = new InfrastructureLogsService(config as any, { send } as any)

    await expect(
      service.query({
        from: '2026-08-13T23:00:00.000Z',
        to: '2026-08-14T01:00:00.000Z',
        search: 'failed\nnext-pattern',
        limit: 50,
      }),
    ).rejects.toThrow('search must not contain control characters')
    expect(send).not.toHaveBeenCalled()
  })
})
