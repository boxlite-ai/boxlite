// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

type ClickStackAuthEnvironment = Record<string, string | undefined>

interface BackofficeStageAuthContract {
  issuer: string
  audience: string
  roleClaim: string
  roleMappings: {
    operator: string[]
    admin: string[]
  }
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Backoffice stage-auth config requires ${name}`)
  }
  return value.trim()
}

function requiredStringArray(value: unknown, name: string) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw new Error(`Backoffice stage-auth config requires non-empty ${name}`)
  }
  return value.map((entry) => entry.trim())
}

function cleanIssuer(value: unknown, name: string) {
  const raw = requiredString(value, name)
  let issuer: URL
  try {
    issuer = new URL(raw)
  } catch {
    throw new Error(`${name} must be a clean HTTPS issuer`)
  }
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    (issuer.pathname !== '' && issuer.pathname !== '/') ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error(`${name} must be a clean HTTPS issuer`)
  }
  return issuer.origin
}

function parseBackofficeStageAuthContract(serialized: string): BackofficeStageAuthContract {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Backoffice stage-auth config must be valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Backoffice stage-auth config must be a JSON object')
  }
  const contract = value as Record<string, unknown>
  const roleMappings = contract.roleMappings
  if (!roleMappings || typeof roleMappings !== 'object' || Array.isArray(roleMappings)) {
    throw new Error('Backoffice stage-auth config requires roleMappings')
  }
  const roles = roleMappings as Record<string, unknown>
  return {
    issuer: cleanIssuer(contract.issuer, 'issuer'),
    audience: requiredString(contract.audience, 'audience'),
    roleClaim: requiredString(contract.roleClaim, 'roleClaim'),
    roleMappings: {
      operator: requiredStringArray(roles.operator, 'roleMappings.operator'),
      admin: requiredStringArray(roles.admin, 'roleMappings.admin'),
    },
  }
}

function commaSeparatedSet(value: string | undefined, name: string) {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0) throw new Error(`${name} must contain at least one value`)
  return new Set(entries)
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

export function backofficeStageAuthParameterName(stage: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(stage))
    throw new Error('stage must contain lowercase letters, digits, or hyphens')
  return `/boxlite/backoffice/${stage}/stage-auth-config`
}

export function verifyClickStackAuthContract(
  environment: ClickStackAuthEnvironment,
  serializedBackofficeContract: string,
) {
  const backoffice = parseBackofficeStageAuthContract(serializedBackofficeContract)

  if (
    cleanIssuer(environment.CLICKSTACK_OIDC_ISSUER_BASE_URL, 'CLICKSTACK_OIDC_ISSUER_BASE_URL') !== backoffice.issuer
  ) {
    throw new Error('CLICKSTACK_OIDC_ISSUER_BASE_URL does not match Backoffice stage-auth config')
  }
  if (requiredString(environment.CLICKSTACK_OIDC_AUDIENCE, 'CLICKSTACK_OIDC_AUDIENCE') !== backoffice.audience) {
    throw new Error('CLICKSTACK_OIDC_AUDIENCE does not match Backoffice stage-auth config')
  }
  if (requiredString(environment.CLICKSTACK_OIDC_ROLE_CLAIM, 'CLICKSTACK_OIDC_ROLE_CLAIM') !== backoffice.roleClaim) {
    throw new Error('CLICKSTACK_OIDC_ROLE_CLAIM does not match Backoffice stage-auth config')
  }

  const configuredRoles = commaSeparatedSet(
    environment.CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES,
    'CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES',
  )
  const expectedRoles = new Set([...backoffice.roleMappings.operator, ...backoffice.roleMappings.admin])
  if (!setsEqual(configuredRoles, expectedRoles)) {
    throw new Error('CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES does not match Backoffice Operator/Admin role mappings')
  }
}
