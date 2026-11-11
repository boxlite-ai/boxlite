import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseBase, type Cloud } from 'mstage/config'
import { apiEnvironmentFrom } from '../src/api-environment.ts'
import type { GroupDeclaration } from '../src/env.ts'

const path = new URL('../../mstage.env.json', import.meta.url)
const config = parseBase(path.pathname, readFileSync(path, 'utf8'))
const declaration: GroupDeclaration = {
  groups: config.envSelectGroup,
  optional: config.envOptional,
  where: path.pathname,
}
const references = {
  aws: 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:boxlite-dev-turnstile-AbCdEf',
  gcp: 'projects/boxlite-dev/secrets/turnstile/versions/3',
}
const turnstile = {
  TURNSTILE_SITEKEY: 'public-sitekey',
  TURNSTILE_EXPECTED_HOSTNAMES: 'app.example.com',
}
const settings = {
  TURNSTILE_TIMEOUT_MS: '7000',
  RATE_LIMIT_REGISTRATION_LIMIT: '12',
  RATE_LIMIT_REGISTRATION_TTL: '900',
  TRUST_PROXY_CIDRS: '10.0.1.0/24,10.0.2.0/24',
}
const fixture = (home: Cloud): Record<string, string> => ({
  ...Object.fromEntries(
    (config.envSelectGroup.api ?? [])
      .filter((key) => !config.envOptional.api?.includes(key))
      .map((key) => [key, 'fixture']),
  ),
  STACK_DOMAIN: 'example.com',
  OIDC_ISSUER_BASE_URL: 'https://auth.example.com',
  ...turnstile,
  TURNSTILE_SECRET_KEY: JSON.stringify({ address: references[home] }),
})
const assemble = (home: Cloud, environment: Record<string, string | undefined>) =>
  apiEnvironmentFrom({ environment, declaration, region: 'ap-southeast-1', stage: 'dev', home })

for (const home of ['aws', 'gcp'] as const) {
  test(`${home}: Turnstile configuration reaches the API through separate value and secret channels`, () => {
    const { environment, secrets } = assemble(home, { ...fixture(home), ...settings })
    for (const [key, value] of Object.entries({ ...turnstile, ...settings })) {
      assert.equal(environment[key], value, key)
      assert.equal(secrets[key], undefined, key)
    }
    assert.equal(secrets.TURNSTILE_SECRET_KEY, references[home])
    assert.equal(environment.TURNSTILE_SECRET_KEY, undefined)
  })

  test(`${home}: optional registration settings leave defaults to the API and an absent sitekey disables delivery`, () => {
    const { environment } = assemble(home, fixture(home))
    for (const key of Object.keys(settings)) assert.equal(environment[key], undefined, key)
    for (const sitekey of [undefined, '', '  ']) {
      const disabled = assemble(home, {
        ...fixture(home),
        ...settings,
        TURNSTILE_SITEKEY: sitekey,
        TURNSTILE_SECRET_KEY: 'unused-credential',
      })
      assert.equal(
        Object.keys(disabled.environment).some((key) => key.startsWith('TURNSTILE_')),
        false,
      )
      assert.equal(disabled.secrets.TURNSTILE_SECRET_KEY, undefined)
    }
  })

  test(`${home}: missing Turnstile credentials or hostnames stop the deployment`, () => {
    for (const key of ['TURNSTILE_EXPECTED_HOSTNAMES', 'TURNSTILE_SECRET_KEY']) {
      const environment = fixture(home)
      delete environment[key]
      assert.throws(() => assemble(home, environment), new RegExp(`${key} is required when TURNSTILE_SITEKEY is set`))
    }
  })

  test(`${home}: Turnstile secret must be a reference for the selected cloud`, () => {
    for (const value of ['plaintext-credential', JSON.stringify({ address: references[home === 'aws' ? 'gcp' : 'aws'] })]) {
      assert.throws(
        () => assemble(home, { ...fixture(home), TURNSTILE_SECRET_KEY: value }),
        (error: Error) => {
          assert.match(error.message, /TURNSTILE_SECRET_KEY/)
          assert.ok(!error.message.includes(value))
          return true
        },
      )
    }
  })
}
