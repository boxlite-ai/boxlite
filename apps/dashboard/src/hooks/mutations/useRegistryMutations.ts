/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateRegistryCredential, RegistryCredential } from '@boxlite-ai/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../queries/queryKeys'
import { useApi } from '../useApi'

/**
 * Adds a login. The password goes up in this one request; the answer, like
 * every read after it, carries no password to cache.
 *
 * A mutation keeps its variables, here the password, in the client's mutation
 * cache while anything observes it. The page resets it when the dialog closes,
 * which lets go of it, and `gcTime: 0` has it collected the moment nothing
 * observes it, after that reset or an unmount, rather than five minutes later.
 */
export const useCreateRegistryMutation = () => {
  const { registriesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<RegistryCredential, unknown, { credential: CreateRegistryCredential; organizationId?: string }>({
    gcTime: 0,
    mutationFn: async ({ credential, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      return (await registriesApi.createRegistryCredential(credential, organizationId)).data
    },
    onSuccess: async (_data, { organizationId }) => {
      if (organizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.registries.list(organizationId) })
      }
    },
  })
}

export const useDeleteRegistryMutation = () => {
  const { registriesApi } = useApi()
  const queryClient = useQueryClient()

  return useMutation<void, unknown, { id: string; organizationId?: string }>({
    mutationFn: async ({ id, organizationId }) => {
      if (!organizationId) {
        throw new Error('No organization selected')
      }
      await registriesApi.deleteRegistryCredential(id, organizationId)
    },
    onSuccess: async (_data, { organizationId }) => {
      if (organizationId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.registries.list(organizationId) })
      }
    },
  })
}
