/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConfigService } from '@nestjs/config'
import { ConfigController } from './config.controller'
import { legalConfig } from './legal-config'
import { LegalVersionService } from './legal-version.service'
import { OidcMetadataService } from './oidc-metadata.service'
import { TypedConfigService } from './typed-config.service'

const env = {
  LEGAL_TOS_VERSION: '2026-11-17',
  LEGAL_PRIVACY_VERSION: '2026-10-10',
  LEGAL_TOS_URL: 'https://example.com/terms',
  LEGAL_PRIVACY_URL: 'https://example.com/privacy',
}

describe('public registration consent configuration', () => {
  it.each(Object.keys(env))('rejects a partial configuration missing %s', (key) => {
    expect(() => legalConfig({ ...env, [key]: '' })).toThrow(key)
  })

  it.each(['javascript:alert(1)', '/terms', 'https://user:pass@example.com/terms'])('rejects URL %s', (url) => {
    expect(() => legalConfig({ ...env, LEGAL_TOS_URL: url })).toThrow('LEGAL_TOS_URL')
  })

  it.each([true, false])('publishes only configured legal settings (enabled=%s)', async (enabled) => {
    const publicConfig = legalConfig(enabled ? env : {})
    const config = new TypedConfigService(new ConfigService({ legal: publicConfig }))
    jest.spyOn(config, 'getOrThrow').mockReturnValue('fixture' as never)
    const metadata = { getEndSessionState: async () => 'present' } as OidcMetadataService
    const dto = await new ConfigController(config, metadata, new LegalVersionService(config)).getConfig()
    const json = JSON.parse(JSON.stringify(dto))
    if (enabled) {
      expect(json.legal).toEqual({
        tosVersion: env.LEGAL_TOS_VERSION,
        privacyVersion: env.LEGAL_PRIVACY_VERSION,
        tosUrl: env.LEGAL_TOS_URL,
        privacyUrl: env.LEGAL_PRIVACY_URL,
      })
    } else {
      expect(json).not.toHaveProperty('legal')
    }
  })
})
