/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxesQueryKey } from '@/hooks/useBoxes'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { PaginatedBoxes, Box, BoxDesiredState, BoxState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

interface UseBoxWsSyncOptions {
  boxId?: string
  refetchOnCreate?: boolean
}

export function useBoxWsSync({ boxId, refetchOnCreate = false }: UseBoxWsSyncOptions = {}) {
  const { notificationSocket } = useNotificationSocket()
  const { selectedOrganization } = useSelectedOrganization()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!notificationSocket || !selectedOrganization?.id) return

    const orgId = selectedOrganization.id

    const updateStateInListCache = (targetId: string, state: BoxState) => {
      queryClient.setQueriesData<PaginatedBoxes>({ queryKey: getBoxesQueryKey(orgId) }, (oldData) => {
        if (!oldData) return oldData
        if (!Array.isArray(oldData.items)) return oldData
        return {
          ...oldData,
          items: oldData.items.map((s) => (s.id === targetId ? { ...s, state } : s)),
        }
      })
    }

    const updateStateInDetailCache = (targetId: string, state: BoxState) => {
      queryClient.setQueryData<Box>(queryKeys.boxes.detail(orgId, targetId), (oldData) => {
        if (!oldData) return oldData
        return { ...oldData, state }
      })
    }

    const matchesActiveBox = (box: Box) => !boxId || box.id === boxId || box.boxId === boxId

    const optimisticUpdate = (box: Box, state: BoxState) => {
      updateStateInListCache(box.id, state)
      if (boxId) {
        updateStateInDetailCache(boxId, state)
        updateStateInDetailCache(box.id, state)
        if (box.boxId) {
          updateStateInDetailCache(box.boxId, state)
        }
      }
    }

    const invalidate = () => {
      queryClient.invalidateQueries({
        queryKey: getBoxesQueryKey(orgId),
        refetchType: 'none',
      })

      if (boxId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.boxes.detail(orgId, boxId),
        })
      }
    }

    const handleCreated = (_box: Box) => {
      if (boxId) return

      queryClient.invalidateQueries({
        queryKey: getBoxesQueryKey(orgId),
        refetchType: refetchOnCreate ? 'active' : 'none',
      })
    }

    const handleStateUpdated = (data: { box: Box; oldState: BoxState; newState: BoxState }) => {
      if (!matchesActiveBox(data.box)) return

      // warm pool boxes — treat as created
      if (data.oldState === data.newState && data.newState === BoxState.STARTED) {
        handleCreated(data.box)
        return
      }

      let updatedState = data.newState

      // error/build_failed with desiredState=DESTROYED should display as destroyed
      if (
        data.box.desiredState === BoxDesiredState.DESTROYED &&
        (data.newState === BoxState.ERROR || data.newState === BoxState.BUILD_FAILED)
      ) {
        updatedState = BoxState.DESTROYED
      }

      optimisticUpdate(data.box, updatedState)
      invalidate()
    }

    const handleDesiredStateUpdated = (data: {
      box: Box
      oldDesiredState: BoxDesiredState
      newDesiredState: BoxDesiredState
    }) => {
      if (!matchesActiveBox(data.box)) return

      if (data.newDesiredState !== BoxDesiredState.DESTROYED) return
      if (data.box.state !== BoxState.ERROR && data.box.state !== BoxState.BUILD_FAILED) return

      optimisticUpdate(data.box, BoxState.DESTROYED)
      invalidate()
    }

    notificationSocket.on('box.created', handleCreated)
    notificationSocket.on('box.state.updated', handleStateUpdated)
    notificationSocket.on('box.desired-state.updated', handleDesiredStateUpdated)

    return () => {
      notificationSocket.off('box.created', handleCreated)
      notificationSocket.off('box.state.updated', handleStateUpdated)
      notificationSocket.off('box.desired-state.updated', handleDesiredStateUpdated)
    }
  }, [notificationSocket, selectedOrganization?.id, boxId, refetchOnCreate, queryClient])
}
