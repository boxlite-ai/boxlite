/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export function legalConfig(env: NodeJS.ProcessEnv = process.env) {
  const tosVersion = env.LEGAL_TOS_VERSION?.trim()
  const privacyVersion = env.LEGAL_PRIVACY_VERSION?.trim()
  const tosUrl = env.LEGAL_TOS_URL?.trim()
  const privacyUrl = env.LEGAL_PRIVACY_URL?.trim()
  if (!tosVersion && !privacyVersion && !tosUrl && !privacyUrl) return undefined
  if (!tosVersion) throw new Error('LEGAL_TOS_VERSION is required')
  if (!privacyVersion) throw new Error('LEGAL_PRIVACY_VERSION is required')
  validateLegalUrl('LEGAL_TOS_URL', tosUrl)
  validateLegalUrl('LEGAL_PRIVACY_URL', privacyUrl)

  return { tosVersion, privacyVersion, tosUrl, privacyUrl }
}

function validateLegalUrl(name: string, value: string | undefined): asserts value is string {
  const url = value ? URL.parse(value) : null
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`)
  }
}
