/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryRunner } from 'typeorm'
import { UnsuspendLegacyPaymentOrganizations1786000600000 } from './1786000600000-unsuspend-legacy-payment-organizations-migration'

describe('UnsuspendLegacyPaymentOrganizations1786000600000', () => {
  it('repairs only the exact legacy payment suspension reason', async () => {
    const runner = { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner

    await new UnsuspendLegacyPaymentOrganizations1786000600000().up(runner)

    const sql = (runner.query as jest.Mock).mock.calls[0][0] as string
    expect(sql).toContain('SET "suspended" = false')
    expect(sql).toContain('"suspendedAt" = NULL')
    expect(sql).toContain('"suspensionReason" = NULL')
    expect(sql).toContain('"suspendedUntil" = NULL')
    expect(sql).toContain('WHERE "suspended" = true')
    expect(sql).toContain(`"suspensionReason" = 'Payment method required'`)
    expect(sql).not.toMatch(/LIKE|ILIKE/)
  })

  it('does not re-suspend repaired organizations on rollback', async () => {
    await expect(new UnsuspendLegacyPaymentOrganizations1786000600000().down()).resolves.toBeUndefined()
  })
})
