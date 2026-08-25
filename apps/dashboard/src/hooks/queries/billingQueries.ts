/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { OrganizationWallet } from '@/billing-api/types/OrganizationWallet'
import type { SeriesGranularity } from '@/billing-api'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { UseQueryOptions } from '@tanstack/react-query'
import { useOrganizationBillingPortalUrlQuery } from './useOrganizationBillingPortalUrlQuery'
import {
  useFetchOrganizationCheckoutUrlQuery,
  useIsOrganizationCheckoutUrlFetching,
} from './useOrganizationCheckoutUrlQuery'
import { useOrganizationInvoicesQuery } from './useOrganizationInvoicesQuery'
import { useOrganizationPaymentMethodsQuery } from './useOrganizationPaymentMethodsQuery'
import { useOrganizationPlanQuery } from './useOrganizationPlanQuery'
import { useOrganizationWalletQuery } from './useOrganizationWalletQuery'
import { useUsageFundingSeriesQuery } from './useUsageFundingSeriesQuery'
import { useOrganizationConcurrencyQuery } from './useOrganizationConcurrencyQuery'
import { GetOrganizationUsageConcurrencyGranularityEnum } from '@boxlite-ai/api-client'

function useSelectedOrgBillingScope() {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  return {
    organizationId: selectedOrganization?.id ?? '',
    enabled: Boolean(selectedOrganization && isOwner),
  }
}

export function useOwnerWalletQuery(
  queryOptions?: Omit<UseQueryOptions<OrganizationWallet>, 'queryKey' | 'queryFn' | 'enabled'>,
) {
  const scope = useSelectedOrgBillingScope()
  return useOrganizationWalletQuery({
    ...scope,
    ...queryOptions,
  })
}

export function useOwnerPlanQuery() {
  const scope = useSelectedOrgBillingScope()
  return useOrganizationPlanQuery(scope)
}

export function useOwnerBillingPortalUrlQuery() {
  const scope = useSelectedOrgBillingScope()
  return useOrganizationBillingPortalUrlQuery(scope)
}

export function useOwnerPaymentMethodsQuery() {
  const scope = useSelectedOrgBillingScope()
  return useOrganizationPaymentMethodsQuery(scope)
}

export function useFetchOwnerCheckoutUrlQuery() {
  const { organizationId } = useSelectedOrgBillingScope()
  const fetchCheckoutUrl = useFetchOrganizationCheckoutUrlQuery()
  return () => fetchCheckoutUrl(organizationId)
}

export function useIsOwnerCheckoutUrlFetching() {
  const { organizationId } = useSelectedOrgBillingScope()
  return useIsOrganizationCheckoutUrlFetching(organizationId)
}

export function useOwnerInvoicesQuery(page?: number, perPage?: number) {
  const scope = useSelectedOrgBillingScope()
  return useOrganizationInvoicesQuery({
    ...scope,
    page,
    perPage,
  })
}

export function useOwnerUsageSeriesQuery(granularity: SeriesGranularity, from: Date, to: Date, enabled = true) {
  const scope = useSelectedOrgBillingScope()
  return useUsageFundingSeriesQuery({
    organizationId: scope.organizationId,
    granularity,
    from,
    to,
    enabled: scope.enabled && enabled,
  })
}

export function useOwnerConcurrencyQuery(
  granularity: GetOrganizationUsageConcurrencyGranularityEnum,
  from: Date,
  to: Date,
  enabled = true,
) {
  const scope = useSelectedOrgBillingScope()
  return useOrganizationConcurrencyQuery({
    organizationId: scope.organizationId,
    granularity,
    from,
    to,
    enabled: scope.enabled && enabled,
  })
}
