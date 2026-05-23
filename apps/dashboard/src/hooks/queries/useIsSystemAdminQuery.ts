/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useQuery } from '@tanstack/react-query'

/**
 * Checks whether the authenticated user has SystemRole.ADMIN by probing
 * GET /admin/overview. Returns false on 403 (non-admin), true on success.
 * Stale time is long (5 min) so it is only fetched once per session.
 */
export function useIsSystemAdminQuery() {
  const { axiosInstance } = useApi()

  const query = useQuery<boolean>({
    queryKey: ['admin', 'is-system-admin'],
    queryFn: () =>
      axiosInstance
        .get('/admin/overview')
        .then(() => true)
        .catch((err) => {
          const status = err?.response?.status
          if (status === 403 || status === 401) return false
          // Network error or unknown — treat as unknown, don't block sidebar
          return false
        }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  return {
    isSystemAdmin: query.data === true,
    isLoading: query.isPending,
  }
}
