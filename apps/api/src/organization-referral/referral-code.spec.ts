import { normalizeReferralCode, normalizeReferralQuery, REFERRAL_PATTERN } from './referral-code'

describe('R02 referral boundary parser', () => {
  it.each([undefined, '', '   '])('ordinary registration for %p', (value) => {
    expect(normalizeReferralCode(value)).toBeUndefined()
  })
  it('normalizes only surrounding whitespace and letter case', () => {
    expect(normalizeReferralCode(' abcd2345ef ')).toBe('ABCD2345EF')
    expect(REFERRAL_PATTERN.test('ABCD2345EF')).toBe(true)
  })
  it.each([null, 123, {}, ['ABCD2345EF'], ['ABCD2345EF', 'ABCD2345EF'], 'ABCD 2345E', 'ABCD2345E0', 'ABCDE2345I'])(
    'rejects malformed %p',
    (value) => {
      expect(() => normalizeReferralCode(value)).toThrow('invalid_referral_code')
    },
  )
  it('rejects bracket query keys under the Express simple query parser', () => {
    expect(() => normalizeReferralQuery({ 'referredCode[]': 'ABCD2345EF' })).toThrow('invalid_referral_code')
  })
})
