/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * These bounds gate credential issuance, so a malformed value must stop the
 * boot rather than silently disable the limit it configures — `parseInt('abc')`
 * is `NaN`, and every comparison against `NaN` is false.
 *
 * `configuration.ts` reads `process.env` at module evaluation, so each case
 * re-imports it in an isolated registry.
 */
const SSH_ENV_KEYS = [
  'SSH_CERTIFICATE_SIGNER_PROVIDER',
  'SSH_CERTIFICATE_DEFAULT_TTL_MINUTES',
  'SSH_CERTIFICATE_MIN_TTL_MINUTES',
  'SSH_CERTIFICATE_MAX_TTL_MINUTES',
  'SSH_CERTIFICATE_CLOCK_SKEW_SECONDS',
  'SSH_CERTIFICATE_MAX_ACTIVE_PER_BOX',
  'SSH_CERTIFICATE_ISSUE_RATE_LIMIT',
  'SSH_CERTIFICATE_ISSUE_RATE_LIMIT_WINDOW_SECONDS',
  'SSH_CERTIFICATE_GUEST_LISTEN_ADDR',
] as const

function loadConfiguration(env: Record<string, string>) {
  let loaded: unknown
  jest.isolateModules(() => {
    for (const key of SSH_ENV_KEYS) {
      delete process.env[key]
    }
    Object.assign(process.env, env)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('./configuration').configuration
  })
  return loaded as { sshCertificate: Record<string, unknown> }
}

describe('sshCertificate configuration', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('uses documented defaults when nothing is set', () => {
    const cfg = loadConfiguration({}).sshCertificate

    expect(cfg.signerProvider).toBe('aws-kms')
    expect(cfg.defaultTtlMinutes).toBe(5)
    expect(cfg.minTtlMinutes).toBe(1)
    expect(cfg.maxTtlMinutes).toBe(60)
    expect(cfg.maxActiveCredentialsPerBox).toBe(10)
  })

  it('accepts explicit numeric overrides', () => {
    const cfg = loadConfiguration({
      SSH_CERTIFICATE_MAX_TTL_MINUTES: '30',
      SSH_CERTIFICATE_MAX_ACTIVE_PER_BOX: '3',
    }).sshCertificate

    expect(cfg.maxTtlMinutes).toBe(30)
    expect(cfg.maxActiveCredentialsPerBox).toBe(3)
  })

  it.each([
    ['SSH_CERTIFICATE_MAX_TTL_MINUTES', 'abc'],
    ['SSH_CERTIFICATE_MAX_ACTIVE_PER_BOX', 'ten'],
    ['SSH_CERTIFICATE_ISSUE_RATE_LIMIT', '0'],
    ['SSH_CERTIFICATE_CLOCK_SKEW_SECONDS', '-5'],
  ])('refuses to boot when %s is %s', (key, value) => {
    // Without this, the bound becomes NaN and the limit stops being enforced —
    // a fail-open on the exact knobs that cap credential issuance.
    expect(() => loadConfiguration({ [key]: value })).toThrow(key)
  })

  it.each([
    ['SSH_CERTIFICATE_MAX_TTL_MINUTES', '5m'],
    ['SSH_CERTIFICATE_MAX_ACTIVE_PER_BOX', '10 '],
    ['SSH_CERTIFICATE_ISSUE_RATE_LIMIT', '+10'],
  ])('refuses to boot when %s has a valid prefix but trailing garbage (%s)', (key, value) => {
    // Number.parseInt reads a PREFIX, so '5m' would silently become 5 — the
    // quiet substitution this helper exists to prevent.
    expect(() => loadConfiguration({ [key]: value })).toThrow(key)
  })

  it.each([
    ['no-port'],
    ['0.0.0.0:0'],
    ['0.0.0.0:70000'],
    ['0.0.0.0:abc'],
    // Valid numeric prefix with trailing garbage, and malformed hosts: all
    // would otherwise slip through to the runner's hostname_port validator and
    // fail at box-create instead of at boot.
    ['0.0.0.0:22abc'],
    ['0.0.0.0:22 '],
    ['0.0.0.0: 22'],
    [':22'],
    ['host with space:22'],
  ])(
    'refuses to boot when the guest listen address is %s',
    (value) => {
      // Unvalidated, a typo here would surface as a runner DTO rejection when
      // someone creates a box, not at boot.
      expect(() => loadConfiguration({ SSH_CERTIFICATE_GUEST_LISTEN_ADDR: value })).toThrow(
        'SSH_CERTIFICATE_GUEST_LISTEN_ADDR',
      )
    },
  )

  it('accepts a valid guest listen address and defaults to 0.0.0.0:22', () => {
    expect(loadConfiguration({}).sshCertificate.guestListenAddr).toBe('0.0.0.0:22')
    expect(
      loadConfiguration({ SSH_CERTIFICATE_GUEST_LISTEN_ADDR: '127.0.0.1:2222' }).sshCertificate.guestListenAddr,
    ).toBe('127.0.0.1:2222')
    expect(
      loadConfiguration({ SSH_CERTIFICATE_GUEST_LISTEN_ADDR: 'guest-host:22' }).sshCertificate.guestListenAddr,
    ).toBe('guest-host:22')
  })

  it('refuses to boot on an unknown signer provider', () => {
    // Casting an unrecognized string to the union would silently route to
    // whichever branch is the fallback.
    expect(() => loadConfiguration({ SSH_CERTIFICATE_SIGNER_PROVIDER: 'aws_kms' })).toThrow(
      'SSH_CERTIFICATE_SIGNER_PROVIDER',
    )
  })

  it('accepts each supported signer provider', () => {
    expect(loadConfiguration({ SSH_CERTIFICATE_SIGNER_PROVIDER: 'local' }).sshCertificate.signerProvider).toBe('local')
    expect(loadConfiguration({ SSH_CERTIFICATE_SIGNER_PROVIDER: 'aws-kms' }).sshCertificate.signerProvider).toBe(
      'aws-kms',
    )
  })
})
