/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { AccountProvider } from '@boxlite-labs/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { queryKeys } from './queryKeys'

export const useAccountProvidersQuery = () => {
  const { userApi } = useApi()

  return useQuery<AccountProvider[]>({
    queryKey: queryKeys.user.accountProviders(),
    queryFn: async () => userApi.getAvailableAccountProviders().then((response) => response.data),
  })
}
