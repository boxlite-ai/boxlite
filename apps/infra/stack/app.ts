// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { PRODUCTION_STAGE } from './settings.js'

export async function configureApp(input: { stage?: string } | undefined) {
  // No dotenv load here: deployment/sst.ts is the single place that composes the deploy environment
  // (local .env knobs, then the stage's SST secret store), and this process inherits the result.
  // Loading .env again would reintroduce a second answer for keys the store now owns.
  const { SST_APP_NAME, resolveAwsRegion } = await import('../deployment/environment.js')
  const REGION = resolveAwsRegion()
  if (!input?.stage) throw new Error('Legacy SST requires an explicit stage')
  const { assertLegacyDeploymentAllowed } = await import('../deployment/aws-ownership.js')
  await assertLegacyDeploymentAllowed({ stage: input.stage, region: REGION })

  return {
    name: SST_APP_NAME,
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
