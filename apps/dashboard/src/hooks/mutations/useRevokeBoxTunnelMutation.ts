/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useMutation } from '@tanstack/react-query'

interface RevokeBoxTunnelVariables {
  boxId: string
  port: number
}

/**
 * Withdraws public access to one port of a box through the route
 * `box.network.revoke_tunnel()` uses. Getting a URL for the port again
 * reopens it at the same address.
 */
export const useRevokeBoxTunnelMutation = () => {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useMutation({
    mutationFn: async ({ boxId, port }: RevokeBoxTunnelVariables): Promise<void> => {
      if (!selectedOrganization?.id) throw new Error('Missing organization')
      await api.revokeTunnel(selectedOrganization.id, boxId, port)
    },
  })
}
