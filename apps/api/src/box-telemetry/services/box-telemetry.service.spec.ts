/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTelemetryService } from './box-telemetry.service'

describe('BoxTelemetryService log search', () => {
  it('passes search text as a literal case-insensitive substring', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([])
    const service = new BoxTelemetryService({ query, isConfigured: () => true } as any)

    await service.getLogs(
      'box-id',
      '2026-08-14T00:00:00.000Z',
      '2026-08-14T01:00:00.000Z',
      1,
      50,
      undefined,
      'failed%_literal',
    )

    expect(query.mock.calls[0][0]).toContain('positionCaseInsensitiveUTF8(Body, {search:String}) > 0')
    expect(query.mock.calls[0][1].search).toBe('failed%_literal')
  })
})
