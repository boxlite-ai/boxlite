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
 * Resolves the public URL for one port of a box through the tunnel route
 * `box.network.tunnel()` uses, which needs inbound access.
 *
 * A mutation rather than a query: it runs for a port the user names, and it
 * changes state, declaring the port public.
 */
export const useBoxPreviewUrlMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useMutation({
    mutationFn: async ({ boxId, port }: BoxPreviewUrlVariables): Promise<string> => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      return api.getTunnelUrl(selectedOrganization.id, boxId, port)
    },
  })
}
