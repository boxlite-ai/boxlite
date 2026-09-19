import { describe, expect, it } from 'vitest'
import { registrationLink } from './referral-link'

describe('Invitation link generation', () => {
  it('keeps the Dashboard origin and port and serializes the invitation code', () => {
    expect(registrationLink('https://dashboard.example:8443', 'ABCD2345EF')).toBe(
      'https://dashboard.example:8443/register?referredCode=ABCD2345EF',
    )
  })
})
