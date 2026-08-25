// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { backofficeStageAuthParameterName, verifyClickStackAuthContract } from './clickstack-auth.js'

const stageAuth = JSON.stringify({
  issuer: 'https://polygala-employees-dev.us.auth0.com',
  clickStackClientId: 'clickstack-client-id',
  audience: 'https://backoffice.polygala.ai/api',
  roleClaim: 'https://backoffice.polygala.ai/roles',
  roleMappings: {
    support: ['backoffice-support'],
    operator: ['backoffice-operator'],
    finance: ['backoffice-finance'],
    admin: ['backoffice-admin'],
  },
})

const gatewayEnvironment = {
  CLICKSTACK_OIDC_ISSUER_BASE_URL: 'https://polygala-employees-dev.us.auth0.com/',
  CLICKSTACK_OIDC_AUDIENCE: 'https://backoffice.polygala.ai/api',
  CLICKSTACK_OIDC_ROLE_CLAIM: 'https://backoffice.polygala.ai/roles',
  CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES: 'backoffice-admin, backoffice-operator',
}

test('derives the stage-scoped Backoffice auth contract parameter', () => {
  assert.equal(backofficeStageAuthParameterName('dev'), '/boxlite/backoffice/dev/stage-auth-config')
  assert.throws(() => backofficeStageAuthParameterName('../prod'), /stage/)
})

test('accepts the exact Backoffice employee auth contract independent of role order', () => {
  assert.equal(verifyClickStackAuthContract(gatewayEnvironment, stageAuth), 'clickstack-client-id')
})

test('requires the ClickStack client ID in the shared employee auth contract', () => {
  const contract = JSON.parse(stageAuth)
  delete contract.clickStackClientId
  assert.throws(() => verifyClickStackAuthContract(gatewayEnvironment, JSON.stringify(contract)), /clickStackClientId/)
})

for (const [name, environment, expected] of [
  [
    'issuer',
    { ...gatewayEnvironment, CLICKSTACK_OIDC_ISSUER_BASE_URL: 'https://customer.example.com/' },
    /CLICKSTACK_OIDC_ISSUER_BASE_URL/,
  ],
  [
    'audience',
    { ...gatewayEnvironment, CLICKSTACK_OIDC_AUDIENCE: 'https://wrong.example.com/api' },
    /CLICKSTACK_OIDC_AUDIENCE/,
  ],
  [
    'role claim',
    { ...gatewayEnvironment, CLICKSTACK_OIDC_ROLE_CLAIM: 'https://wrong.example.com/roles' },
    /CLICKSTACK_OIDC_ROLE_CLAIM/,
  ],
  [
    'allowed roles',
    { ...gatewayEnvironment, CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES: 'backoffice-support,backoffice-admin' },
    /CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES/,
  ],
] as const) {
  test(`rejects a ClickStack ${name} that drifts from Backoffice`, () => {
    assert.throws(() => verifyClickStackAuthContract(environment, stageAuth), expected)
  })
}

test('rejects an unreadable or incomplete Backoffice auth contract without echoing it', () => {
  assert.throws(() => verifyClickStackAuthContract(gatewayEnvironment, 'not-json'), /valid JSON/)
  assert.throws(
    () => verifyClickStackAuthContract(gatewayEnvironment, JSON.stringify({ audience: 'secret-looking-value' })),
    (error: Error) =>
      /Backoffice stage-auth config/.test(error.message) && !error.message.includes('secret-looking-value'),
  )
})
