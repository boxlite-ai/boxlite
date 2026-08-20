/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface'

interface CorsEnvironment {
  DASHBOARD_URL?: string
  APP_URL?: string
  CORS_ALLOWED_ORIGINS?: string
}

export function dashboardCorsOptions(environment: CorsEnvironment = process.env): CorsOptions {
  const allowedOrigins = [
    environment.DASHBOARD_URL,
    environment.APP_URL,
    ...(environment.CORS_ALLOWED_ORIGINS?.split(',') ?? []),
  ]
    .map((origin) => origin?.trim())
    .filter((origin): origin is string => !!origin)

  return {
    origin: allowedOrigins.length > 0 ? [...new Set(allowedOrigins)] : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    exposedHeaders: ['Retry-After'],
  }
}
