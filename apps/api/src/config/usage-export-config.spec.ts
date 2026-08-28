/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { commerceAdmissionConfig, usageExportConfig, USAGE_EXPORT_VISIBILITY_TIMEOUT_MS } from './configuration'

const env = (overrides: Record<string, string> = {}) => ({ USAGE_EXPORT_ENABLED: 'true', ...overrides })

const enabled = (overrides: Record<string, string> = {}) =>
  env({ USAGE_EXPORT_URL: 'https://commerce.test', USAGE_EXPORT_TOKEN: 'tok', ...overrides })

describe('usageExportConfig', () => {
  it('defaults to disabled and demands nothing', () => {
    expect(usageExportConfig({})).toEqual({
      enabled: false,
      allocationSnapshotEnabled: false,
      url: undefined,
      token: undefined,
      batchSize: 200,
      timeoutMs: 10_000,
      maxAttempts: 10,
    })
  })

  // Enabled without a destination posts to "undefined/internal/usage-events",
  // spends the retry budget and blocks the batch — a stall dressed up as a
  // delivery failure.
  it.each([
    ['no URL', env({ USAGE_EXPORT_TOKEN: 'tok' }), /USAGE_EXPORT_URL is required/],
    ['a blank URL', enabled({ USAGE_EXPORT_URL: '   ' }), /USAGE_EXPORT_URL is required/],
    ['no token', env({ USAGE_EXPORT_URL: 'https://commerce.test' }), /USAGE_EXPORT_TOKEN is required/],
    ['a blank token', enabled({ USAGE_EXPORT_TOKEN: '' }), /USAGE_EXPORT_TOKEN is required/],
  ])('refuses to start when export is enabled with %s', (_case, environment, expected) => {
    expect(() => usageExportConfig(environment)).toThrow(expected)
  })

  it('accepts a fully configured export', () => {
    expect(usageExportConfig(enabled())).toEqual(
      expect.objectContaining({ enabled: true, url: 'https://commerce.test', token: 'tok' }),
    )
  })

  // parseInt would read each of these as a number and carry on: "1e9" becomes 1,
  // so a budget meant to be enormous gives up on the first blip, and a typo
  // becomes NaN, which never compares true and so never stops retrying.
  it.each([
    ['a typo', 'abc'],
    ['exponent notation', '1e9'],
    ['a trailing suffix', '20abc'],
    ['zero', '0'],
    ['a negative', '-1'],
    ['a decimal', '2.5'],
  ])('rejects %s in a count', (_case, value) => {
    expect(() => usageExportConfig(enabled({ USAGE_EXPORT_MAX_ATTEMPTS: value }))).toThrow(
      /USAGE_EXPORT_MAX_ATTEMPTS must be a whole number/,
    )
  })

  it.each([
    ['USAGE_EXPORT_BATCH_SIZE', 'batchSize'],
    ['USAGE_EXPORT_TIMEOUT_MS', 'timeoutMs'],
    ['USAGE_EXPORT_MAX_ATTEMPTS', 'maxAttempts'],
  ])('validates %s', (variable, field) => {
    expect(() => usageExportConfig(enabled({ [variable]: 'nonsense' }))).toThrow(new RegExp(variable))
    expect(usageExportConfig(enabled({ [variable]: '7' }))).toEqual(expect.objectContaining({ [field]: 7 }))
  })

  it('falls back when a count is absent or blank', () => {
    expect(usageExportConfig(enabled({ USAGE_EXPORT_BATCH_SIZE: '  ' }))).toEqual(
      expect.objectContaining({ batchSize: 200 }),
    )
  })

  // A destination axios can never reach fails exactly like no destination at
  // all: every delivery errors, the retry budget drains, and the batch blocks.
  // Only the shape of the value separates the two, so only the shape can catch it.
  it.each([
    ['a bare hostname', 'commerce'],
    ['a scheme-relative URL', '//commerce.test'],
    ['a path', '/internal'],
    ['an empty-looking URL', 'http://'],
  ])('refuses %s as the destination', (_case, url) => {
    expect(() => usageExportConfig(enabled({ USAGE_EXPORT_URL: url }))).toThrow(
      /USAGE_EXPORT_URL must be an absolute http\(s\) URL/,
    )
  })

  // A URL is the one setting that can carry credentials in its userinfo, so a
  // rejection must not put the value in a boot log. An http(s) URL with
  // credentials is accepted and so never echoed either way; the scheme error is
  // the reachable leak.
  it('names the variable without echoing the rejected URL', () => {
    expect(() => usageExportConfig(enabled({ USAGE_EXPORT_URL: 'ftp://user:secret@commerce.test' }))).toThrow(
      /^USAGE_EXPORT_URL must use http or https$/,
    )
  })

  it.each([
    ['ftp', 'ftp://commerce.test'],
    ['file', 'file:///etc/passwd'],
  ])('refuses the %s scheme', (_case, url) => {
    expect(() => usageExportConfig(enabled({ USAGE_EXPORT_URL: url }))).toThrow(/must use http or https/)
  })

  it.each([
    ['http', 'http://commerce.test'],
    ['https with a port', 'https://commerce.test:3100'],
    ['a path prefix', 'https://commerce.test/api/billing'],
  ])('accepts %s', (_case, url) => {
    expect(usageExportConfig(enabled({ USAGE_EXPORT_URL: url }))).toEqual(expect.objectContaining({ url }))
  })

  // The publisher appends its own path to whatever is stored, so a destination
  // carrying a query or fragment could never reach the receiver. Rejecting beats
  // trimming, which would deliver somewhere other than what was configured.
  // A bare delimiter is the case that reads as absent: URL parses "…/api?" to an
  // empty search, so asking the parsed value whether it has a query answers no
  // while the "?" is still there in the string that gets stored — and the
  // publisher then posts to "…/api?/internal/usage-events". A trailing "?" also
  // hides the slash from the trim, since /\/+$/ cannot match it.
  it.each([
    ['a query', 'https://commerce.test/api?target=1'],
    ['a fragment', 'https://commerce.test/api#section'],
    ['a bare query delimiter', 'https://commerce.test/api?'],
    ['a bare fragment delimiter', 'https://commerce.test/api#'],
    ['a bare delimiter behind a trailing slash', 'https://commerce.test/api/?'],
  ])('refuses a destination carrying %s', (_case, url) => {
    expect(() => usageExportConfig(enabled({ USAGE_EXPORT_URL: url }))).toThrow(
      /USAGE_EXPORT_URL must not carry a query or fragment/,
    )
  })

  // The publisher appends "/internal/usage-events", so a stored trailing slash
  // would produce a double slash in the path.
  it('trims a trailing slash from the destination', () => {
    expect(usageExportConfig(enabled({ USAGE_EXPORT_URL: 'https://commerce.test/' }))).toEqual(
      expect.objectContaining({ url: 'https://commerce.test' }),
    )
  })

  // Only the trailing slash may change. Rebuilding from origin + pathname looks
  // equivalent and is not: it drops userinfo — which axios turns into Basic auth,
  // deleting the publisher's Bearer header — drops an explicit port, and
  // lowercases the host.
  it.each([
    ['userinfo', 'https://user:secret@commerce.test/api'],
    ['an explicit port', 'https://commerce.test:443/api'],
    ['host casing', 'https://Commerce.TEST/API'],
  ])('stores the destination verbatim, preserving %s', (_case, url) => {
    expect(usageExportConfig(enabled({ USAGE_EXPORT_URL: url }))).toEqual(expect.objectContaining({ url }))
  })

  // A request still in flight when its rows become claimable again is delivered
  // twice — doubling load exactly when the receiver is already too slow.
  it.each([
    ['at the window', String(USAGE_EXPORT_VISIBILITY_TIMEOUT_MS)],
    ['past the window', String(USAGE_EXPORT_VISIBILITY_TIMEOUT_MS + 1)],
  ])('refuses a timeout %s', (_case, timeout) => {
    expect(() => usageExportConfig(enabled({ USAGE_EXPORT_TIMEOUT_MS: timeout }))).toThrow(
      /must be below the .* claim visibility window/,
    )
  })

  it('accepts a timeout just below the window', () => {
    expect(
      usageExportConfig(enabled({ USAGE_EXPORT_TIMEOUT_MS: String(USAGE_EXPORT_VISIBILITY_TIMEOUT_MS - 1) })),
    ).toEqual(expect.objectContaining({ timeoutMs: USAGE_EXPORT_VISIBILITY_TIMEOUT_MS - 1 }))
  })

  // Nothing enforces the relationship at runtime, so the default has to satisfy
  // it on its own.
  it('ships a default timeout inside the window', () => {
    expect(usageExportConfig(enabled()).timeoutMs).toBeLessThan(USAGE_EXPORT_VISIBILITY_TIMEOUT_MS)
  })
})

describe('commerceAdmissionConfig', () => {
  it('enables only when the shared Commerce URL and token are both present', () => {
    expect(commerceAdmissionConfig({})).toEqual({
      enabled: false,
      url: undefined,
      token: undefined,
      timeoutMs: 500,
    })
    expect(commerceAdmissionConfig({ USAGE_EXPORT_URL: 'https://commerce.test', USAGE_EXPORT_TOKEN: '' })).toEqual(
      expect.objectContaining({ enabled: false }),
    )
    expect(
      commerceAdmissionConfig({ USAGE_EXPORT_URL: 'https://commerce.test/', USAGE_EXPORT_TOKEN: 'token' }),
    ).toEqual({ enabled: true, url: 'https://commerce.test', token: 'token', timeoutMs: 500 })
  })

  it('validates its independent timeout', () => {
    expect(() => commerceAdmissionConfig({ COMMERCE_ADMISSION_TIMEOUT_MS: '0' })).toThrow(
      /COMMERCE_ADMISSION_TIMEOUT_MS/,
    )
    expect(
      commerceAdmissionConfig({
        USAGE_EXPORT_URL: 'https://commerce.test',
        USAGE_EXPORT_TOKEN: 'token',
        COMMERCE_ADMISSION_TIMEOUT_MS: '750',
      }),
    ).toEqual(expect.objectContaining({ timeoutMs: 750 }))
  })
})

// The allocation snapshot cron posts to the same destination and token as
// finalized-usage export, so it demands the same two settings — but it can be
// turned on while export itself stays off, and each flag alone must be enough
// to require them.
describe('usageExportConfig when only the allocation snapshot is enabled', () => {
  const snapshotOnly = (overrides: Record<string, string> = {}) => ({
    USAGE_EXPORT_ENABLED: 'false',
    USAGE_ALLOCATION_SNAPSHOT_ENABLED: 'true',
    ...overrides,
  })

  it.each([
    ['no URL', snapshotOnly({ USAGE_EXPORT_TOKEN: 'tok' }), /USAGE_EXPORT_URL is required/],
    ['no token', snapshotOnly({ USAGE_EXPORT_URL: 'https://commerce.test' }), /USAGE_EXPORT_TOKEN is required/],
  ])('refuses to start with %s', (_case, environment, expected) => {
    expect(() => usageExportConfig(environment)).toThrow(expected)
  })

  it('accepts a fully configured destination', () => {
    expect(
      usageExportConfig(snapshotOnly({ USAGE_EXPORT_URL: 'https://commerce.test', USAGE_EXPORT_TOKEN: 'tok' })),
    ).toEqual(
      expect.objectContaining({
        enabled: false,
        allocationSnapshotEnabled: true,
        url: 'https://commerce.test',
        token: 'tok',
      }),
    )
  })

  // The claim-visibility invariant exists only for the claim-based outbox
  // export; the snapshot cron is a stateless full-replace push with no claim to
  // double up, so its own timeout has nothing to violate.
  it('does not enforce the export claim-visibility timeout window', () => {
    expect(() =>
      usageExportConfig(
        snapshotOnly({
          USAGE_EXPORT_URL: 'https://commerce.test',
          USAGE_EXPORT_TOKEN: 'tok',
          USAGE_EXPORT_TIMEOUT_MS: String(USAGE_EXPORT_VISIBILITY_TIMEOUT_MS),
        }),
      ),
    ).not.toThrow()
  })
})

// Delivery is what these rules describe, and delivery does not happen while
// export is off. Refusing to boot over a setting nothing reads would fail a
// stage for a placeholder it was entitled to leave behind.
describe('usageExportConfig while export is disabled', () => {
  const disabled = (overrides: Record<string, string> = {}) => ({ USAGE_EXPORT_ENABLED: 'false', ...overrides })

  it.each([
    ['a placeholder destination', { USAGE_EXPORT_URL: 'commerce-tbd' }],
    ['an unsupported scheme', { USAGE_EXPORT_URL: 'ftp://commerce.test' }],
    ['a timeout at the window', { USAGE_EXPORT_TIMEOUT_MS: String(USAGE_EXPORT_VISIBILITY_TIMEOUT_MS) }],
    ['a timeout past the window', { USAGE_EXPORT_TIMEOUT_MS: String(USAGE_EXPORT_VISIBILITY_TIMEOUT_MS * 2) }],
    ['no destination at all', {}],
    ['a destination with no token', { USAGE_EXPORT_URL: 'https://commerce.test' }],
  ])('still boots with %s', (_case, overrides) => {
    expect(() => usageExportConfig(disabled(overrides))).not.toThrow()
  })

  // Malformed counts are malformed in every state, so those stay fatal.
  it('still rejects a malformed count', () => {
    expect(() => usageExportConfig(disabled({ USAGE_EXPORT_BATCH_SIZE: 'abc' }))).toThrow(/USAGE_EXPORT_BATCH_SIZE/)
  })

  // Enabling later is what turns the placeholder into a fault, and it must.
  it('rejects the same placeholder once export is enabled', () => {
    expect(() => usageExportConfig(enabled({ USAGE_EXPORT_URL: 'commerce-tbd' }))).toThrow(
      /USAGE_EXPORT_URL must be an absolute http\(s\) URL/,
    )
  })
})
