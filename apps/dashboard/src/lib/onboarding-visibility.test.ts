import { describe, expect, it } from 'vitest'
import { shouldAutoOpenOnboarding, type OnboardingAutoOpenSignals } from './onboarding-visibility'

// A brand-new signup on a brand-new browser: nothing dismissed, empty account.
const freshSignup: OnboardingAutoOpenSignals = {
  requestedByUrl: false,
  dismissedInThisBrowser: false,
  accountStateLoaded: true,
  hasApiKeys: false,
  hasBoxes: false,
}

const signals = (overrides: Partial<OnboardingAutoOpenSignals>): OnboardingAutoOpenSignals => ({
  ...freshSignup,
  ...overrides,
})

describe('shouldAutoOpenOnboarding', () => {
  it('opens for a brand-new user with an empty account', () => {
    expect(shouldAutoOpenOnboarding(freshSignup)).toBe(true)
  })

  it('stays shut for a returning user on a new browser who already has an API key', () => {
    // The reported bug: localStorage is empty because the browser is new, but the
    // account is plainly not new.
    expect(shouldAutoOpenOnboarding(signals({ hasApiKeys: true }))).toBe(false)
  })

  it('stays shut for a returning user on a new browser who already has a box', () => {
    expect(shouldAutoOpenOnboarding(signals({ hasBoxes: true }))).toBe(false)
  })

  it('stays shut once dismissed in this browser', () => {
    expect(shouldAutoOpenOnboarding(signals({ dismissedInThisBrowser: true }))).toBe(false)
  })

  it('waits for account state rather than flashing open at a returning user', () => {
    expect(shouldAutoOpenOnboarding(signals({ accountStateLoaded: false }))).toBe(false)
  })

  it('opens on ?onboarding=1 even for a dismissed, fully onboarded account', () => {
    // The sidebar "Onboarding" entry routes through this param; it must always win.
    expect(
      shouldAutoOpenOnboarding(
        signals({ requestedByUrl: true, dismissedInThisBrowser: true, hasApiKeys: true, hasBoxes: true }),
      ),
    ).toBe(true)
  })

  it('opens on ?onboarding=1 before account state has loaded', () => {
    expect(shouldAutoOpenOnboarding(signals({ requestedByUrl: true, accountStateLoaded: false }))).toBe(true)
  })
})
