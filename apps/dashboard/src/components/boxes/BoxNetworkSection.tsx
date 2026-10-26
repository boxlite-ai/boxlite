/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useBoxPreviewUrlMutation } from '@/hooks/mutations/useBoxPreviewUrlMutation'
import { useUpdateBoxInboundMutation } from '@/hooks/mutations/useUpdateBoxInboundMutation'
import { Box, NetworkMode } from '@boxlite-ai/api-client'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { BoxNetworkPanel } from './BoxNetworkPanel'
import { BoxPreviewUrlDialog } from './BoxPreviewUrlDialog'

/**
 * Wires the network section to the box APIs.
 *
 * Both server calls live in the hooks layer — `useUpdateBoxInboundMutation`
 * (which also owns cache invalidation) and `useBoxPreviewUrlMutation` — so this
 * component issues no HTTP of its own and only orchestrates.
 */
export function BoxNetworkSection({ box, canManage }: { box: Box; canManage: boolean }) {
  const toggleInbound = useUpdateBoxInboundMutation()
  const previewUrl = useBoxPreviewUrlMutation()

  const [dialogOpen, setDialogOpen] = useState(false)

  const setInbound = useCallback(
    (mode: NetworkMode) => {
      toggleInbound.mutate(
        { boxId: box.id, mode },
        {
          // Named for what actually changed: tunnel reachability, not the
          // box as a whole.
          onSuccess: () =>
            toast.success(
              mode === NetworkMode.ENABLED ? 'Tunnel URLs are open to anyone' : 'Tunnel URLs require signing in',
            ),
          onError: () => toast.error('Could not change inbound access'),
        },
      )
    },
    [box.id, toggleInbound],
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
        network={box.network}
        inboundPending={toggleInbound.isPending}
        canManage={canManage}
        onToggleInbound={setInbound}
        onGetUrl={openDialog}
      />
      <BoxPreviewUrlDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        url={previewUrl.data}
        isFetching={previewUrl.isPending}
        error={previewUrl.isError ? 'Could not get a URL for that port.' : undefined}
        onFetchUrl={fetchUrl}
      />
    </>
  )
}
