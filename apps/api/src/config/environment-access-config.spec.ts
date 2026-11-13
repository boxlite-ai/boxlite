import { environmentAccessConfig } from './environment-access-config'

describe('environment access configuration', () => {
  const management = {
    OIDC_MANAGEMENT_API_ENABLED: 'true',
    OIDC_MANAGEMENT_API_CLIENT_ID: 'client',
    OIDC_MANAGEMENT_API_CLIENT_SECRET: 'test-secret',
    OIDC_MANAGEMENT_API_AUDIENCE: 'https://issuer.test/api/v2/',
  }
  it('leaves local and production policy disabled without an explicit setting', () => {
    expect(environmentAccessConfig({})).toBeUndefined()
  })
  it.each(['dev', 'stage'])('enables %s only with Management credentials', (environment) => {
    expect(environmentAccessConfig({ ...management, OIDC_INTERNAL_ACCESS_ENVIRONMENT: environment })).toBe(environment)
    expect(() => environmentAccessConfig({ OIDC_INTERNAL_ACCESS_ENVIRONMENT: environment })).toThrow('ENABLED=true')
  })
  it('rejects unsupported environments and missing credentials', () => {
    expect(() => environmentAccessConfig({ ...management, OIDC_INTERNAL_ACCESS_ENVIRONMENT: 'prod' })).toThrow(
      'dev or stage',
    )
    expect(() =>
      environmentAccessConfig({
        ...management,
        OIDC_MANAGEMENT_API_CLIENT_SECRET: '',
        OIDC_INTERNAL_ACCESS_ENVIRONMENT: 'dev',
      }),
    ).toThrow('CLIENT_SECRET')
  })
})
