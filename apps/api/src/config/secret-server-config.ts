/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

export function secretServerConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean
  url?: string
  devToken?: string
} {
  const enabled = env.SECRET_SERVER_ENABLED === 'true'
  if (!enabled) return { enabled: false }

  const raw = env.SECRET_SERVER_URL?.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('SECRET_SERVER_URL must be an absolute HTTP(S) URL when SECRET_SERVER_ENABLED is true')
  }
  const local = env.ENVIRONMENT === 'local' || env.ENVIRONMENT === 'dev'
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    (!local && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    raw.includes('?') ||
    raw.includes('#')
  ) {
    throw new Error(
      'SECRET_SERVER_URL requires HTTPS outside local/dev and must not contain credentials, query or fragment',
    )
  }
  const devToken = env.SECRET_SERVER_DEV_TOKEN?.trim() || undefined
  if (devToken && !local) throw new Error('SECRET_SERVER_DEV_TOKEN is only allowed in local/dev')
  return { enabled, url: raw.replace(/\/+$/, ''), devToken }
}
