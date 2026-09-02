/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useBoxPreviewUrlMutation } from '@/hooks/mutations/useBoxPreviewUrlMutation'
import { useUpdateBoxPublicStatusMutation } from '@/hooks/mutations/useUpdateBoxPublicStatusMutation'
import { Box } from '@boxlite-ai/api-client'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { BoxNetworkPanel } from './BoxNetworkPanel'
import { BoxPreviewUrlDialog } from './BoxPreviewUrlDialog'

/**
 * Wires the network section to the box APIs.
 *
 * Both server calls live in the hooks layer — `useUpdateBoxPublicStatusMutation`
 * (which also owns cache invalidation) and `useBoxPreviewUrlMutation` — so this
 * component issues no HTTP of its own and only orchestrates.
 */
export function BoxNetworkSection({ box, canManage }: { box: Box; canManage: boolean }) {
  const togglePublic = useUpdateBoxPublicStatusMutation()
  const previewUrl = useBoxPreviewUrlMutation()

  const [dialogOpen, setDialogOpen] = useState(false)

  const setPublic = useCallback(
    (next: boolean) => {
      togglePublic.mutate(
        { boxId: box.id, isPublic: next },
        {
          // Named for what actually changed: preview reachability, not the
          // box as a whole.
          onSuccess: () =>
            toast.success(next ? 'Preview URLs are open to anyone' : 'Preview URLs require signing in'),
          onError: () => toast.error('Could not change preview access'),
        },
      )
    },
    [box.id, togglePublic],
  )

  const openDialog = useCallback(() => {
    // Start clean each time: a URL left over from a previous port would read as
    // the answer to the port about to be typed.
    previewUrl.reset()
    setDialogOpen(true)
  }, [previewUrl])

  const fetchUrl = useCallback(
    (port: number) => {
      previewUrl.mutate({ boxId: box.id, port })
    },
    [box.id, previewUrl],
  )

  return (
    <>
      <BoxNetworkPanel
        isPublic={box.public ?? false}
        isPublicPending={togglePublic.isPending}
        canManage={canManage}
        onTogglePublic={setPublic}
        onGetUrl={openDialog}
      />
      <BoxPreviewUrlDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        isPublic={box.public ?? false}
        url={previewUrl.data}
        isFetching={previewUrl.isPending}
        error={previewUrl.isError ? 'Could not get a URL for that port.' : undefined}
        onFetchUrl={fetchUrl}
      />
    </>
  )
}
