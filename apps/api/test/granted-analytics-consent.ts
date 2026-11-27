import type { AnalyticsConsentService, AnalyticsSubjects } from '../src/analytics/services/analytics-consent.service'

/** Existing transport tests exercise eligible events. Database authorization is covered separately. */
export const grantedAnalyticsConsent = {
  async dispatch(_subjects: AnalyticsSubjects, _at: Date, send: () => Promise<void>) {
    await send()
    return true
  },
} as AnalyticsConsentService
