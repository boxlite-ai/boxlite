import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { turnstileConfig } from './turnstile-config'
import { ConfigurationDto } from './dto/configuration.dto'

const fixture = {
  TURNSTILE_SITEKEY: 'public-key',
  TURNSTILE_SECRET_KEY: 'private-server-value',
  TURNSTILE_EXPECTED_HOSTNAMES: 'dashboard.example.test, localhost, dashboard.example.test',
}

describe('Turnstile configuration', () => {
  it('parses allowed hosts and supplies the default timeout and action', () => {
    expect(turnstileConfig(fixture)).toEqual({
      sitekey: 'public-key',
      secretKey: 'private-server-value',
      expectedHostnames: ['dashboard.example.test', 'localhost'],
      timeoutMs: 5000,
      action: 'signup',
    })
  })

  it('normalizes DNS case before deduplicating the hostname allowlist', () => {
    expect(
      turnstileConfig({
        ...fixture,
        TURNSTILE_EXPECTED_HOSTNAMES: ' Console.Example.COM, console.example.com, LOCALHOST ',
      }).expectedHostnames,
    ).toEqual(['console.example.com', 'localhost'])
  })

  it('starts from the checked-in infra-local template without external widget credentials', () => {
    const environment = parse(readFileSync(resolve(__dirname, '../../../infra-local/api.env')))
    expect(turnstileConfig(environment)).toBeUndefined()
  })

  it.each(['TURNSTILE_SITEKEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_EXPECTED_HOSTNAMES'])(
    'uses %s according to whether protection is enabled',
    (name) => {
      for (const value of [undefined, '', '  ']) {
        if (name === 'TURNSTILE_SITEKEY') expect(turnstileConfig({ ...fixture, [name]: value })).toBeUndefined()
        else expect(() => turnstileConfig({ ...fixture, [name]: value })).toThrow(name)
      }
    },
  )

  it.each(['', '0', '-1', '1.5', 'abc'])('rejects timeout %s without logging its value', (value) => {
    expect(() => turnstileConfig({ ...fixture, TURNSTILE_TIMEOUT_MS: value })).toThrow(
      'TURNSTILE_TIMEOUT_MS must be a positive integer',
    )
  })

  it.each(['https://example.test', 'example.test:443', 'example.test/path', 'example.test,', '*.example.test'])(
    'rejects non-hostname configuration %s',
    (value) => {
      expect(() => turnstileConfig({ ...fixture, TURNSTILE_EXPECTED_HOSTNAMES: value })).toThrow(
        'TURNSTILE_EXPECTED_HOSTNAMES',
      )
    },
  )

  it('projects only public widget fields and observes the next configuration value', () => {
    const config = turnstileConfig(fixture)
    const get = (key: string) => (key === 'turnstile' ? config : undefined)
    const service = { get, getOrThrow: get }
    const dto = new ConfigurationDto(service as never, { endSessionState: 'present' })
    expect(dto.turnstile).toEqual({ sitekey: 'public-key', action: 'signup' })
    expect(JSON.stringify(dto)).not.toContain(config.secretKey)
    expect(JSON.stringify(dto)).not.toContain('dashboard.example.test')
    config.sitekey = 'next-public-key'
    expect(new ConfigurationDto(service as never, { endSessionState: 'present' }).turnstile.sitekey).toBe(
      'next-public-key',
    )
  })
})
