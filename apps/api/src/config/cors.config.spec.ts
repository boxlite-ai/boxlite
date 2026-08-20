/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { dashboardCorsOptions } from './cors.config'

describe('dashboardCorsOptions', () => {
  it('exposes the server resend cooldown to the cross-origin dashboard', () => {
    expect(
      dashboardCorsOptions({
        DASHBOARD_URL: 'https://dashboard.boxlite.test',
        APP_URL: ' https://app.boxlite.test ',
        CORS_ALLOWED_ORIGINS: 'https://dashboard.boxlite.test,https://preview.boxlite.test',
      }),
    ).toMatchObject({
      origin: ['https://dashboard.boxlite.test', 'https://app.boxlite.test', 'https://preview.boxlite.test'],
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      credentials: true,
      exposedHeaders: ['Retry-After'],
    })
  })
})
