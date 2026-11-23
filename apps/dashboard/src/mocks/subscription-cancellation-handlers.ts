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
const receipts = new Map<string, Record<string, unknown>>()
const feedback = new Map<string, unknown>()
const subscriptionId = '20332033-2033-4033-8033-203320332033'

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
          subscriptionId,
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
    http.post(`${billingUrl}/organization/:organizationId/plan/cancellations`, async ({ request }) => {
      if (['readonly', 'none'].includes(cancellationScenario)) return new HttpResponse(null, { status: 403 })
      const body = (await request.json()) as Record<string, unknown>
      const id = String(body.operationId)
      if (receipts.has(id)) return HttpResponse.json(receipts.get(id))
      if (parameters.get('failure') === 'cancel' && !cancellationFailedOnce) {
        cancellationFailedOnce = true
        return HttpResponse.json({ message: 'Cancellation was not confirmed' }, { status: 503 })
      }
      canceled = true
      const receipt = {
        ...body,
        endsAt: body.cycleTo,
        feedbackState: body.feedbackExpected ? 'awaiting' : 'not_requested',
      }
      receipts.set(id, receipt)
      return HttpResponse.json(receipt)
    }),
    http.get(`${billingUrl}/organization/:organizationId/plan/cancellations/:operationId`, ({ params }) =>
      receipts.has(String(params.operationId))
        ? HttpResponse.json(receipts.get(String(params.operationId)))
        : new HttpResponse(null, { status: 404 }),
    ),
    http.post(
      `${billingUrl}/organization/:organizationId/plan/cancellations/:operationId/feedback`,
      async ({ request, params }) => {
        const id = String(params.operationId)
        if (!receipts.has(id)) return new HttpResponse(null, { status: 404 })
        if (parameters.get('failure') === 'feedback' && !feedbackFailedOnce) {
          feedbackFailedOnce = true
          return new HttpResponse(null, { status: 503 })
        }
        feedback.set(id, await request.json())
        return HttpResponse.json({ saved: true, savedAt: new Date().toISOString() })
      },
    ),
    http.post(`${billingUrl}/organization/:organizationId/plan/upgrade`, async () => {
      if (cancellationScenario === 'trial') return new HttpResponse(null, { status: 409 })
      canceled = false
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}
