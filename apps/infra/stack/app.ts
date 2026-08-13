// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { PRODUCTION_STAGE } from './settings.js'

export async function configureApp(input: { stage?: string } | undefined) {
  const { loadDeploymentEnvironment, resolveAwsRegion } = await import('../deployment/environment.js')
  loadDeploymentEnvironment()
  const REGION = resolveAwsRegion()

  return {
    name: 'boxlite',
    removal: input?.stage === PRODUCTION_STAGE ? ('retain' as const) : ('remove' as const),
    home: 'aws' as const,
    providers: {
      aws: {
        version: '7.24.0',
        region: REGION,
        ...(process.env.AWS_PROFILE ? { profile: process.env.AWS_PROFILE } : {}),
      },
      cloudflare: '6.15.0',
      random: '4.16.6',
      command: '1.0.1',
    },
  }
}
