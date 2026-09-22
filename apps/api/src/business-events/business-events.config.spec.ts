import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { businessEventsConfig } from './business-events.config'

describe('P04 business events configuration', () => {
  const connection = {
    BUSINESS_EVENTS_ENABLED: 'true',
    USAGE_EXPORT_URL: 'http://commerce.test/',
    USAGE_EXPORT_TOKEN: 'test-token',
  }
  it('can be enabled independently of usage export and uses Story budgets', () => {
    expect(businessEventsConfig({ ...connection, USAGE_EXPORT_ENABLED: 'false' })).toEqual({
      enabled: true,
      url: 'http://commerce.test',
      token: 'test-token',
      intervalMs: 30000,
      batchSize: 20,
      concurrency: 4,
      timeoutMs: 10000,
      visibilityMs: 120000,
      maxAttempts: 10,
      maxBackoffMs: 900000,
    })
  })
  it('requires valid connection only when enabled', () => {
    expect(businessEventsConfig({}).enabled).toBe(false)
    expect(businessEventsConfig({ BUSINESS_EVENTS_ENABLED: 'false' }).enabled).toBe(false)
    expect(() => businessEventsConfig({ BUSINESS_EVENTS_ENABLED: 'true' })).toThrow('USAGE_EXPORT_URL')
    expect(() => businessEventsConfig({ ...connection, USAGE_EXPORT_TOKEN: '' })).toThrow('USAGE_EXPORT_TOKEN')
  })
  it('loads the native local environment without a Commerce service', () => {
    const local = parse(readFileSync(resolve(__dirname, '../../../infra-local/api.env'), 'utf8'))
    expect(businessEventsConfig(local).enabled).toBe(false)
  })
  it.each([
    'https://user:secret@commerce.test',
    'commerce',
    'ftp://commerce',
    'http://commerce?x=1',
    'http://commerce/#x',
    'http://commerce/api/billing',
  ])('rejects unsafe base URL without echoing it', (url) => {
    expect(() => businessEventsConfig({ ...connection, USAGE_EXPORT_URL: url })).toThrow('USAGE_EXPORT_URL')
  })
  it.each(['0', '-1', '1.5', '1e3', 'bad'])('rejects malformed counts %s', (count) => {
    expect(() => businessEventsConfig({ ...connection, BUSINESS_EVENTS_BATCH_SIZE: count })).toThrow('BATCH_SIZE')
  })
  it('rejects a batch that can outlive its lease', () => {
    expect(() => businessEventsConfig({ ...connection, BUSINESS_EVENTS_VISIBILITY_MS: '55000' })).toThrow('whole batch')
  })
})

// The switch is read from process.env inside the factory, so this runs against a fresh module
// registry: importing configuration.ts while publishing was enabled by default is what once
// threw on a host with no Commerce settings.
describe('business events startup without a Commerce connection', () => {
  const keys = ['BUSINESS_EVENTS_ENABLED', 'USAGE_EXPORT_URL', 'USAGE_EXPORT_TOKEN'] as const
  const saved: Partial<Record<(typeof keys)[number], string>> = {}

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    jest.resetModules()
  })

  afterEach(() => {
    for (const key of keys) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('imports and evaluates with publishing disabled', () => {
    const { configuration } = require('../config/configuration') as typeof import('../config/configuration')
    expect(configuration().businessEvents.enabled).toBe(false)
  })
})
