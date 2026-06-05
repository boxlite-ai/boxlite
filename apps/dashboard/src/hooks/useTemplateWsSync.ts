/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { queryKeys } from '@/hooks/queries/queryKeys'
import type { PaginatedBoxTemplates } from '@/hooks/queries/useTemplatesPageQuery'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { BoxTemplateDto, BoxTemplateState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

export function useTemplateWsSync() {
  const { notificationSocket } = useNotificationSocket()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!notificationSocket || !selectedOrganization?.id) return

    const templateListQueryKey = queryKeys.templates.list(selectedOrganization.id)
    const paginatedTemplateListQueryKey = queryKeys.templates.paginatedList(selectedOrganization.id)

    const updateTemplateInCacheIfPresent = (template: BoxTemplateDto) => {
      queryClient.setQueryData<BoxTemplateDto[]>(templateListQueryKey, (previousTemplates) => {
        if (!previousTemplates) return previousTemplates
        if (!previousTemplates.some((existingTemplate) => existingTemplate.id === template.id)) return previousTemplates

        return previousTemplates.map((existingTemplate) =>
          existingTemplate.id === template.id ? template : existingTemplate,
        )
      })

      queryClient.setQueriesData<PaginatedBoxTemplates>(
        { queryKey: paginatedTemplateListQueryKey },
        (previousTemplates) => {
          if (!previousTemplates) return previousTemplates
          if (!previousTemplates.items.some((existingTemplate) => existingTemplate.id === template.id))
            return previousTemplates

          return {
            ...previousTemplates,
            items: previousTemplates.items.map((existingTemplate) =>
              existingTemplate.id === template.id ? template : existingTemplate,
            ),
          }
        },
      )
    }

    const invalidate = (refetchType: 'active' | 'none' = 'none') => {
      queryClient.invalidateQueries({
        queryKey: templateListQueryKey,
        refetchType,
      })
      queryClient.invalidateQueries({
        queryKey: paginatedTemplateListQueryKey,
        refetchType,
      })
    }

    const handleTemplateCreatedEvent = () => {
      invalidate('active')
    }

    const handleTemplateStateUpdatedEvent = (data: {
      template: BoxTemplateDto
      oldState: BoxTemplateState
      newState: BoxTemplateState
    }) => {
      updateTemplateInCacheIfPresent(data.template)
      invalidate()
    }

    const handleTemplateRemovedEvent = () => {
      invalidate('active')
    }

    notificationSocket.on('template.created', handleTemplateCreatedEvent)
    notificationSocket.on('template.state.updated', handleTemplateStateUpdatedEvent)
    notificationSocket.on('template.removed', handleTemplateRemovedEvent)

    return () => {
      notificationSocket.off('template.created', handleTemplateCreatedEvent)
      notificationSocket.off('template.state.updated', handleTemplateStateUpdatedEvent)
      notificationSocket.off('template.removed', handleTemplateRemovedEvent)
    }
  }, [notificationSocket, queryClient, selectedOrganization?.id])
}
