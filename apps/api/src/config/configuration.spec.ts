/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('configuration', () => {
  const originalRuntimeLeaseSeconds = process.env.BILLING_RUNTIME_LEASE_SECONDS

  afterEach(() => {
    if (originalRuntimeLeaseSeconds === undefined) {
      delete process.env.BILLING_RUNTIME_LEASE_SECONDS
    } else {
      process.env.BILLING_RUNTIME_LEASE_SECONDS = originalRuntimeLeaseSeconds
    }
    jest.resetModules()
  })

  it('defaults the runtime lease to the balanced 60-second window', async () => {
    delete process.env.BILLING_RUNTIME_LEASE_SECONDS
    jest.resetModules()

    const { configuration } = await import('./configuration')

    expect(configuration.billing.runtimeLeaseSeconds).toBe(60)
  })
})
