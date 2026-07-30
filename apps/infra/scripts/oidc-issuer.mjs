// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

function validateOidcIssuer(name, value) {
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain leading or trailing whitespace`)
  }

  let issuer
  try {
    issuer = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid absolute HTTPS URL`)
  }

  if (issuer.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS`)
  }
  if (issuer.username || issuer.password) {
    throw new Error(`${name} must not include credentials`)
  }
  if (issuer.search || issuer.hash) {
    throw new Error(`${name} must not include a query string or fragment`)
  }

  return value
}

export function requireOidcIssuer(environment = process.env) {
  const value = environment.OIDC_ISSUER_BASE_URL
  if (!value) {
    throw new Error('OIDC_ISSUER_BASE_URL is required (e.g. https://<tenant>.auth0.com/)')
  }
  return validateOidcIssuer('OIDC_ISSUER_BASE_URL', value)
}

export function optionalPublicOidcIssuer(environment = process.env) {
  const value = environment.PUBLIC_OIDC_DOMAIN
  if (value === undefined || value === '') return undefined
  return validateOidcIssuer('PUBLIC_OIDC_DOMAIN', value)
}
