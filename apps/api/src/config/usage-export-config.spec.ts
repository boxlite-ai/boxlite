/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { usageExportConfig } from './configuration'

const env = (overrides: Record<string, string> = {}) => ({ USAGE_EXPORT_ENABLED: 'true', ...overrides })

const enabled = (overrides: Record<string, string> = {}) =>
  env({ USAGE_EXPORT_URL: 'https://commerce.test', USAGE_EXPORT_TOKEN: 'tok', ...overrides })

describe('usageExportConfig', () => {
  it('defaults to disabled and demands nothing', () => {
    expect(usageExportConfig({})).toEqual({
      enabled: false,
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
})
