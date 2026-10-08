/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegistryCredential } from '@boxlite-ai/api-client'
import { useQuery } from '@tanstack/react-query'
import { useApi } from '../useApi'
import { useSelectedOrganization } from '../useSelectedOrganization'
import { queryKeys } from './queryKeys'

export function useRegistriesQuery() {
  const { registriesApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()

  return useQuery<RegistryCredential[]>({
    queryKey: queryKeys.registries.list(selectedOrganization?.id ?? ''),
    queryFn: async () => {
      if (!selectedOrganization) {
        throw new Error('No organization selected')
      }
      const response = await registriesApi.listRegistryCredentials(selectedOrganization.id)
      return response.data
    },
    enabled: !!selectedOrganization,
  })
}
