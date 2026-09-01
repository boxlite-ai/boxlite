/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useMutation } from '@tanstack/react-query'

interface BoxPreviewUrlVariables {
  boxId: string
  port: number
}

/**
 * Resolves the preview URL for one port of a box.
 *
 * A mutation rather than a query, even though it reads: it runs in response to a
 * click for a port the user names, and the result must not be cached — the
 * endpoint also returns the box auth token, which has no reason to sit in a
 * shared store where devtools, a HAR capture or error reporting would pick it
 * up. `useMutation` gives the imperative call, `isPending` and `error` without
 * a cache entry.
 */
export const useBoxPreviewUrlMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useMutation({
    mutationFn: async ({ boxId, port }: BoxPreviewUrlVariables): Promise<string> => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      const { data } = await api.boxApi.getPortPreviewUrl(boxId, port, selectedOrganization.id)
      return data.url
    },
  })
}
