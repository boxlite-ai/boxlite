/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { oidcAccountLinkConfig } from './configuration'

describe('oidcAccountLinkConfig', () => {
  it('leaves the account link off without a secret', () => {
    expect(oidcAccountLinkConfig({})).toEqual({ enabled: false, secret: undefined })
    expect(oidcAccountLinkConfig({ OIDC_ACCOUNT_LINK_SECRET: '  ' })).toEqual({ enabled: false, secret: undefined })
  })

  it('refuses to boot with a key shorter than HS256 needs', () => {
    expect(() => oidcAccountLinkConfig({ OIDC_ACCOUNT_LINK_SECRET: 'k'.repeat(31) })).toThrow(
      'OIDC_ACCOUNT_LINK_SECRET must hold at least 32 characters',
    )
  })

  it('turns the account link on with a long enough key', () => {
    expect(oidcAccountLinkConfig({ OIDC_ACCOUNT_LINK_SECRET: 'k'.repeat(32) })).toEqual({
      enabled: true,
      secret: 'k'.repeat(32),
    })
  })
})
