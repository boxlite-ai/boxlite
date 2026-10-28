/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { SignupCreditDelivery } from '@/billing-api'
import { useQuery, useQueryClient, type QueryState } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useConfig } from '../useConfig'
import { queryKeys } from './queryKeys'

const MAX_READS = 8
const MAX_READ_INTERVAL_MS = 30_000

/**
 * When to read the signup credit again, or false when there is nothing left to
 * wait for: it arrived, the last read failed, or the read window is spent.
 *
 * `delivered: false` cannot tell a credit on its way from one that never
 * comes, so the wait is bounded: reads 2, 4, 8, 16, 30, 30 and 30 s apart,
 * about two minutes in all. A failed read ends it too; an error keeps the
 * last `false`, and counting only answers would poll the error forever.
 */
export function nextSignupCreditReadMs(
  state: Pick<QueryState<SignupCreditDelivery>, 'data' | 'dataUpdateCount' | 'status'> | undefined,
): number | false {
  if (state?.data?.delivered !== false || state.status === 'error' || state.dataUpdateCount >= MAX_READS) {
    return false
  }
  return Math.min(MAX_READ_INTERVAL_MS, 1_000 * 2 ** state.dataUpdateCount)
}

/**
 * Whether the organization's signup credit is still on its way. When it lands,
 * the wallet and its ledger are refetched before this turns false, so the
 * balance shows the credit as the notice goes.
 */
export const useOrganizationSignupCreditPending = ({
  organizationId,
  enabled = true,
}: {
  organizationId: string
  enabled?: boolean
}): boolean => {
  const { billingApi } = useApi()
  const config = useConfig()
  const queryClient = useQueryClient()
  const queryKey = queryKeys.organization.signupCredit(organizationId)
  const isEnabled = Boolean(enabled && config.billingApiUrl && organizationId)

  useQuery<SignupCreditDelivery>({
    queryKey,
    queryFn: async () => {
      const wasPending = queryClient.getQueryData<SignupCreditDelivery>(queryKey)?.delivered === false
      const delivery = await billingApi.getSignupCreditDelivery(organizationId)
      if (wasPending && delivery.delivered) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.organization.wallet(organizationId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.billing.transactions(organizationId) }),
        ])
      }
      return delivery
    },
    enabled: isEnabled,
    refetchInterval: (query) => nextSignupCreditReadMs(query.state),
    // Re-render on each answer or failure, and only then: the read count lives
    // on the cache entry, not the result, and a repeated `false` leaves `data`.
    notifyOnChangeProps: ['dataUpdatedAt', 'status'],
  })

  return isEnabled && nextSignupCreditReadMs(queryClient.getQueryState(queryKey)) !== false
}
