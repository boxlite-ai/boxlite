export interface OnboardingAutoOpenSignals {
  /** `?onboarding=1` is present — an explicit request to open the guide. */
  requestedByUrl: boolean
  /** This browser has recorded a dismissal for this user. Per-browser, so never load-bearing alone. */
  dismissedInThisBrowser: boolean
  /** Account-state signals below have resolved. False while loading, and on query error. */
  accountStateLoaded: boolean
  /** The organization owns at least one API key. */
  hasApiKeys: boolean
  /** The organization owns at least one box, any state (unfiltered fleet count). */
  hasBoxes: boolean
}

/**
 * Decides whether the Quickstart guide should auto-open on the boxes page.
 *
 * "Has this user been onboarded?" is a per-account fact, but the dismissal flag lives in
 * localStorage, which is scoped to one browser profile. A returning user on a new browser,
 * a second device, or after clearing site data therefore looks identical to a fresh signup.
 * The account-state signals close that gap: an organization that already owns an API key or
 * a box has demonstrably been through the quickstart, whatever this browser remembers.
 */
export function shouldAutoOpenOnboarding(signals: OnboardingAutoOpenSignals): boolean {
  // An explicit request always wins — the sidebar "Onboarding" entry routes through
  // ?onboarding=1, and it has to keep working for people who finished long ago.
  if (signals.requestedByUrl) return true

  // Only ever suppresses within the browser that recorded it. Cross-browser suppression is
  // the account signals' job below — that split is the whole point of this function.
  if (signals.dismissedInThisBrowser) return false

  // Bail while account state is unknown. The old default was "open", which is why a
  // storage miss showed the guide to established users; an unresolved (or failed)
  // query must not be able to do the same.
  if (!signals.accountStateLoaded) return false

  return !signals.hasApiKeys && !signals.hasBoxes
}
