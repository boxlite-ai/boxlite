/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

export function environmentAccessConfig(env: NodeJS.ProcessEnv = process.env): 'dev' | 'stage' | undefined {
  const environment = env.OIDC_INTERNAL_ACCESS_ENVIRONMENT?.trim()
  if (!environment) return undefined
  if (environment !== 'dev' && environment !== 'stage') {
    throw new Error('OIDC_INTERNAL_ACCESS_ENVIRONMENT must be dev or stage')
  }
  if (env.OIDC_MANAGEMENT_API_ENABLED !== 'true') {
    throw new Error('Internal access management requires OIDC_MANAGEMENT_API_ENABLED=true')
  }
  for (const name of ['CLIENT_ID', 'CLIENT_SECRET', 'AUDIENCE']) {
    if (!env[`OIDC_MANAGEMENT_API_${name}`]?.trim()) {
      throw new Error(`Internal access management requires OIDC_MANAGEMENT_API_${name}`)
    }
  }
  return environment
}
