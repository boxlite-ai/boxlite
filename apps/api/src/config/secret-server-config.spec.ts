/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { secretServerConfig } from './secret-server-config'

describe('Secret Server configuration', () => {
  const enabled = { SECRET_SERVER_ENABLED: 'true', SECRET_SERVER_URL: 'https://secrets.example' }

  it('defaults off without requiring a destination or credentials', () => {
    expect(secretServerConfig({})).toEqual({ enabled: false, url: undefined, devToken: undefined })
    expect(secretServerConfig({ SECRET_SERVER_ENABLED: 'false', SECRET_SERVER_URL: 'invalid' }).enabled).toBe(false)
  })

  it('enables Google identity without a static token and trims trailing slashes', () => {
    expect(secretServerConfig({ ...enabled, SECRET_SERVER_URL: ' https://secrets.example/// ' })).toEqual({
      enabled: true,
      url: 'https://secrets.example',
      devToken: undefined,
    })
  })

  it.each([
    undefined,
    '',
    'invalid',
    'ftp://secrets.example',
    'http://secrets.example',
    'https://user:pass@secrets.example',
    'https://secrets.example?',
    'https://secrets.example#',
  ])('rejects invalid or insecure enabled URL %s', (url) => {
    expect(() => secretServerConfig({ ...enabled, SECRET_SERVER_URL: url })).toThrow(/SECRET_SERVER_URL/)
  })

  it.each(['staging', 'production', undefined])('rejects dev credentials in %s', (environment) => {
    expect(() =>
      secretServerConfig({ ...enabled, ENVIRONMENT: environment, SECRET_SERVER_DEV_TOKEN: 'local-token' }),
    ).toThrow(/SECRET_SERVER_DEV_TOKEN/)
  })

  it.each(['local', 'dev'])('permits HTTP fake and static token only in %s', (environment) => {
    expect(
      secretServerConfig({
        ...enabled,
        ENVIRONMENT: environment,
        SECRET_SERVER_URL: 'http://127.0.0.1:8080/',
        SECRET_SERVER_DEV_TOKEN: ' local-token ',
      }),
    ).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:8080',
      devToken: 'local-token',
    })
  })
})
