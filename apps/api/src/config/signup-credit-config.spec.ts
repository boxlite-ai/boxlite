import { SIGNUP_CREDIT_MAX_CENTS, signupCreditConfig } from './configuration'

describe('signupCreditConfig', () => {
  it('is safely disabled by default', () => {
    expect(signupCreditConfig({})).toEqual({
      amountCents: 0,
      deliveryEnabled: false,
      url: undefined,
      token: undefined,
      batchSize: 50,
      concurrency: 10,
      timeoutMs: 3_000,
    })
  })

  it('enables enqueue and delivery only with an exact cents amount, destination, and token', () => {
    expect(
      signupCreditConfig({
        SIGNUP_CREDIT_CENTS: '10000',
        SIGNUP_CREDIT_EXPORT_URL: 'https://commerce.test/',
        SIGNUP_CREDIT_EXPORT_TOKEN: ' secret ',
      }),
    ).toMatchObject({
      amountCents: 10_000,
      deliveryEnabled: true,
      url: 'https://commerce.test',
      token: 'secret',
    })
  })

  it('allows amount zero with a configured exporter so existing rows can drain', () => {
    expect(
      signupCreditConfig({
        SIGNUP_CREDIT_CENTS: '0',
        SIGNUP_CREDIT_EXPORT_URL: 'https://commerce.test',
        SIGNUP_CREDIT_EXPORT_TOKEN: 'secret',
      }),
    ).toMatchObject({ amountCents: 0, deliveryEnabled: true })
  })

  it('ignores a malformed BILLING_API_URL while signup credit is off', () => {
    expect(signupCreditConfig({ BILLING_API_URL: 'commerce' })).toMatchObject({
      deliveryEnabled: false,
      url: undefined,
    })
  })

  it('ignores a malformed exporter URL while delivery is disabled', () => {
    expect(signupCreditConfig({ SIGNUP_CREDIT_EXPORT_URL: 'commerce' })).toMatchObject({
      deliveryEnabled: false,
      url: undefined,
    })
  })

  it('defaults the exporter to the bare BILLING_API_URL origin', () => {
    expect(
      signupCreditConfig({
        SIGNUP_CREDIT_CENTS: '10000',
        SIGNUP_CREDIT_EXPORT_URL: ' ',
        SIGNUP_CREDIT_EXPORT_TOKEN: 'secret',
        BILLING_API_URL: 'https://commerce.test/api/billing',
      }),
    ).toMatchObject({ url: 'https://commerce.test' })
  })

  it('normalizes an explicit exporter to its origin before appending the internal route', () => {
    expect(
      signupCreditConfig({
        SIGNUP_CREDIT_EXPORT_URL: 'https://commerce.test/api/billing?ignored=true',
        SIGNUP_CREDIT_EXPORT_TOKEN: 'secret',
      }),
    ).toMatchObject({ url: 'https://commerce.test' })
  })

  it.each([
    [{ SIGNUP_CREDIT_CENTS: '1.5' }, /non-negative whole number/],
    [{ SIGNUP_CREDIT_CENTS: String(SIGNUP_CREDIT_MAX_CENTS + 1) }, /at most/],
    [{ SIGNUP_CREDIT_CENTS: '10000' }, /EXPORT_TOKEN/],
    [{ SIGNUP_CREDIT_CENTS: '10000', SIGNUP_CREDIT_EXPORT_TOKEN: 'secret' }, /EXPORT_URL/],
    [{ SIGNUP_CREDIT_EXPORT_TOKEN: 'secret' }, /EXPORT_URL/],
    [{ SIGNUP_CREDIT_EXPORT_TOKEN: 'secret', BILLING_API_URL: 'commerce' }, /BILLING_API_URL must be an absolute/],
    [{ SIGNUP_CREDIT_CENTS: '10000', BILLING_API_URL: 'commerce' }, /EXPORT_TOKEN/],
    [
      {
        SIGNUP_CREDIT_EXPORT_TOKEN: 'secret',
        SIGNUP_CREDIT_EXPORT_URL: 'https://commerce.test',
        SIGNUP_CREDIT_EXPORT_BATCH_SIZE: '50',
        SIGNUP_CREDIT_EXPORT_CONCURRENCY: '10',
        SIGNUP_CREDIT_EXPORT_TIMEOUT_MS: '6000',
      },
      /visibility window/,
    ],
    [
      {
        SIGNUP_CREDIT_EXPORT_TOKEN: 'secret',
        SIGNUP_CREDIT_EXPORT_URL: 'https://commerce.test',
        SIGNUP_CREDIT_EXPORT_BATCH_SIZE: '1',
        SIGNUP_CREDIT_EXPORT_CONCURRENCY: '1',
        SIGNUP_CREDIT_EXPORT_TIMEOUT_MS: '29000',
      },
      /visibility window/,
    ],
  ])('rejects unsafe configuration %#', (environment, error) => {
    expect(() => signupCreditConfig(environment)).toThrow(error)
  })
})
