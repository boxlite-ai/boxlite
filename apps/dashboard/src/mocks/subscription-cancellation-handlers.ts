/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { http, HttpResponse } from 'msw'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { MOCK_ORGANIZATION_MEMBER } from './fixtures'
const parameters = new URLSearchParams(window.location.search)
export const cancellationScenario = parameters.get('scenario') || 'paid'
const enabled = parameters.get('preview') === 'subscription-cancel'
let cancellationFailedOnce = false

let canceled = cancellationScenario === 'scheduled'
let feedbackFailedOnce = false
const feedback = new Map<string, unknown>()

export function subscriptionCancellationHandlers(apiUrl: string, billingUrl: string) {
  if (!enabled) return []
  return [
    http.get(`${apiUrl}/organizations/:organizationId/users`, () =>
      HttpResponse.json([
        {
          ...MOCK_ORGANIZATION_MEMBER,
          role: cancellationScenario === 'readonly' ? OrganizationUserRoleEnum.MEMBER : OrganizationUserRoleEnum.OWNER,
        },
      ]),
    ),
    http.get(`${billingUrl}/organization/:organizationId/plan`, async () => {
      if (cancellationScenario === 'none') return HttpResponse.json({})
      const trial = cancellationScenario === 'trial'
      const cycleTo = trial ? '2026-11-26T00:00:00Z' : '2026-12-23T00:00:00Z'
      return HttpResponse.json({
        plan: {
          planId: 'pro',
          planName: 'Pro',
          status: 'active',
          cycleFrom: '2026-11-23T00:00:00Z',
          cycleTo,
          includedQuotaCents: 25000,
          quotaConsumedCents: 6250,
          quotaRemainingCents: 18750,
          ...(canceled ? { cancelAtPeriodEnd: true } : {}),
          ...(trial
            ? {
                trial: {
                  startedAt: '2026-11-23T00:00:00Z',
                  endsAt: cycleTo,
                  conversionAmountCents: 14900,
                  currency: 'USD',
                  conversionState: 'not_attempted',
                },
              }
            : {}),
        },
      })
    }),
    http.post(`${billingUrl}/organization/:organizationId/plan/downgrade`, async ({ request }) => {
      if (['readonly', 'none'].includes(cancellationScenario)) return new HttpResponse(null, { status: 403 })
      const body = (await request.json()) as { planId: string | null }
      if (body.planId !== null) return new HttpResponse(null, { status: 400 })
      if (parameters.get('failure') === 'cancel' && !cancellationFailedOnce) {
        cancellationFailedOnce = true
        return new HttpResponse(null, { status: 503 })
      }
      canceled = true
      return new HttpResponse(null, { status: 204 })
    }),
    http.put(`${apiUrl}/organizations/:organizationId/cancellation-feedback`, async ({ request, params }) => {
      if (cancellationScenario === 'readonly') return new HttpResponse(null, { status: 403 })
      if (parameters.get('failure') === 'feedback' && !feedbackFailedOnce) {
        feedbackFailedOnce = true
        return new HttpResponse(null, { status: 503 })
      }
      feedback.set(String(params.organizationId), {
        ...((await request.json()) as object),
        submittedBy: MOCK_ORGANIZATION_MEMBER.userId,
        submittedAt: new Date().toISOString(),
      })
      return new HttpResponse(null, { status: 204 })
    }),
    http.post(`${billingUrl}/organization/:organizationId/plan/upgrade`, async () => {
      if (cancellationScenario === 'trial') return new HttpResponse(null, { status: 409 })
      canceled = false
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}
