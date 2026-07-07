/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

async function loadConfiguration(env: Record<string, string | undefined>) {
  jest.resetModules()
  const originalEnv = process.env
  process.env = { ...originalEnv, ...env }
  try {
    const module = await import('./configuration')
    return module.configuration
  } finally {
    process.env = originalEnv
  }
}

describe('configuration URL contract', () => {
  afterEach(() => {
    jest.resetModules()
  })

  it('derives public and dashboard REST URLs from the dashboard API base', async () => {
    const configuration = await loadConfiguration({
      DASHBOARD_BASE_API_URL: 'https://dev.boxlite.ai',
      PUBLIC_REST_API_BASE_URL: undefined,
    })

    expect(configuration.dashboardBaseApiUrl).toBe('https://dev.boxlite.ai')
    expect(configuration.urls).toEqual({
      publicRestApiUrl: 'https://dev.boxlite.ai/api',
      dashboardApiUrl: 'https://dev.boxlite.ai/api',
    })
  })

  it('keeps the public quickstart URL independent from the dashboard runtime URL', async () => {
    const configuration = await loadConfiguration({
      DASHBOARD_BASE_API_URL: 'https://dev.boxlite.ai',
      PUBLIC_REST_API_BASE_URL: 'https://api.dev.boxlite.ai/api',
    })

    expect(configuration.urls).toEqual({
      publicRestApiUrl: 'https://api.dev.boxlite.ai/api',
      dashboardApiUrl: 'https://dev.boxlite.ai/api',
    })
  })

  it('does not double-append /api when the dashboard API base is misconfigured', async () => {
    const configuration = await loadConfiguration({
      DASHBOARD_BASE_API_URL: 'https://dev.boxlite.ai/api/',
      PUBLIC_REST_API_BASE_URL: undefined,
    })

    expect(configuration.dashboardBaseApiUrl).toBe('https://dev.boxlite.ai')
    expect(configuration.urls.dashboardApiUrl).toBe('https://dev.boxlite.ai/api')
  })
})
