// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const CLOUDFLARE_PROVIDER_VERSION = '6.15.0'

export function resolveCloudflareProviderRegistration(environment = process.env) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('Cloudflare provider registration requires an environment object')
  }
  const hasApiToken = Boolean(environment.CLOUDFLARE_API_TOKEN?.trim())
  const hasAccountId = Boolean(environment.CLOUDFLARE_DEFAULT_ACCOUNT_ID?.trim())
  const installProviders = environment.BOXLITE_SST_INSTALL_PROVIDERS ?? ''
  if (installProviders !== '' && installProviders !== '1') {
    throw new Error('Cloudflare provider installation mode is invalid')
  }
  if (hasApiToken !== hasAccountId) {
    throw new Error('Cloudflare API token and account ID must be supplied together')
  }
  return hasApiToken || installProviders === '1' ? { cloudflare: CLOUDFLARE_PROVIDER_VERSION } : {}
}
