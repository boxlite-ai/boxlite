/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PaymentUrl } from '@/billing-api/types/Invoice'
import { shouldRetryBillingMutation } from '@/billing-api/billingOperation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

interface TopUpWalletVariables {
  organizationId: string
  amountCents: number
  idempotencyKey: string
}

export const useTopUpWalletMutation = () => {
  const { billingApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<PaymentUrl, unknown, TopUpWalletVariables>({
    mutationFn: ({ organizationId, amountCents, idempotencyKey }) =>
      billingApi.topUpWallet(organizationId, amountCents, idempotencyKey),
    retry: shouldRetryBillingMutation,
    onSuccess: (_data, { organizationId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organization.wallet(organizationId) })
    },
  })
}
