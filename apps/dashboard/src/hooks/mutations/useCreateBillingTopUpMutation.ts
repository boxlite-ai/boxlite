/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { BillingTopUpResult } from '@/billing-api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { nanoid } from 'nanoid'
import { useRef } from 'react'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface CreateBillingTopUpVariables {
  organizationId: string
  amountCents: string
}

interface PendingTopUpRequest extends CreateBillingTopUpVariables {
  idempotencyKey: string
}

export function useCreateBillingTopUpMutation() {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()
  const pendingRequest = useRef<PendingTopUpRequest | null>(null)

  return useMutation<BillingTopUpResult, unknown, CreateBillingTopUpVariables>({
    mutationFn: ({ organizationId, amountCents }) => {
      const existing = pendingRequest.current
      const request =
        existing?.organizationId === organizationId && existing.amountCents === amountCents
          ? existing
          : { organizationId, amountCents, idempotencyKey: nanoid() }
      pendingRequest.current = request
      return billingApi.createBillingTopUp(organizationId, amountCents, request.idempotencyKey)
    },
    onSuccess: async (result, { organizationId, amountCents }) => {
      if (
        pendingRequest.current?.organizationId === organizationId &&
        pendingRequest.current.amountCents === amountCents
      ) {
        pendingRequest.current = null
      }
      if (result.checkoutUrl) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.payment(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.overviewRoot(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.billing.receiptsRoot(organizationId) }),
      ])
    },
  })
}
