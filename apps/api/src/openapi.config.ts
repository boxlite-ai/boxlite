/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DocumentBuilder } from '@nestjs/swagger'

const getOpenApiConfig = (oidcIssuer: string) =>
  new DocumentBuilder()
    .setTitle('BoxLite')
    .addServer('http://localhost:3000')
    .setDescription('BoxLite AI platform API Docs')
    .setContact('BoxLite Platforms Inc.', 'https://www.boxlite.io', 'support@boxlite.com')
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'API Key access',
    })
    .addOAuth2({
      type: 'openIdConnect',
      flows: undefined,
      openIdConnectUrl: `${oidcIssuer}/.well-known/openid-configuration`,
    })
    .build()

export { getOpenApiConfig }
