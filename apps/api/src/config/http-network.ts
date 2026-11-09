/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { NestExpressApplication } from '@nestjs/platform-express'

export function configureHttpNetwork(app: NestExpressApplication, trustedProxies: string[], env = process.env): void {
  const origins = [
    ...new Set(
      [env.DASHBOARD_URL, env.APP_URL, ...(env.CORS_ALLOWED_ORIGINS?.split(',') ?? [])]
        .map((origin) => origin?.trim())
        .filter((origin): origin is string => !!origin),
    ),
  ]
  if (!origins.length) {
    Logger.warn(
      'CORS: no DASHBOARD_URL / APP_URL / CORS_ALLOWED_ORIGINS set; reflecting request origin. Set one to restrict cross-origin access.',
      'Bootstrap',
    )
  }
  app.enableCors({
    origin: origins.length ? origins : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    exposedHeaders: ['Retry-After'],
  })
  app.set('trust proxy', trustedProxies.length ? trustedProxies : false)
}
