/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useUpdateBoxInboundMutation } from '@/hooks/mutations/useUpdateBoxInboundMutation'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { Box, NetworkMode } from '@boxlite-ai/api-client'
import { useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { BoxDomainBindings } from './BoxDomainBindings'
import { BoxNetworkPanel } from './BoxNetworkPanel'
import { BoxOutboundPolicy } from './BoxOutboundPolicy'
import { BoxTunnelDialog } from './BoxTunnelDialog'

/** Scope the dialog to its authenticated client; switching context discards secrets and late results. */
export function BoxNetworkSection({
  box,
  canManage,
  children,
}: {
  box: Box
  canManage: boolean
  children?: ReactNode
}) {
  const api = useApi()
  const { user } = useAuth()
  const { selectedOrganization } = useSelectedOrganization()
  const organizationId = selectedOrganization?.id
  const toggleInbound = useUpdateBoxInboundMutation()
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<{
    api: typeof api
    organizationId: string
    boxId: string
  } | null>(null)
  const current = useRef({ api, organizationId, boxId: box.id, canManage })
  current.current = { api, organizationId, boxId: box.id, canManage }
  // Render-time reset prevents a previous account's secret from flashing for one effect frame.
  if (
    dialog &&
    (dialog.api !== api || dialog.organizationId !== organizationId || dialog.boxId !== box.id || !canManage)
  )
    setDialog(null)

  function open() {
    if (canManage && organizationId) setDialog({ api, organizationId, boxId: box.id })
  }
  function setInbound(mode: NetworkMode) {
    if (!canManage || toggleInbound.isPending) return
    const scope = current.current
    const stillCurrent = () =>
      current.current.api === scope.api &&
      current.current.organizationId === scope.organizationId &&
      current.current.boxId === scope.boxId &&
      current.current.canManage
    toggleInbound.mutate(
      { boxId: box.id, mode },
      {
        onSuccess: () => {
          if (stillCurrent())
            toast.success(mode === NetworkMode.ENABLED ? 'Inbound access enabled' : 'Inbound access disabled')
        },
        onError: () => {
          if (stillCurrent()) toast.error('Could not change inbound access')
        },
      },
    )
  }
  const active =
    dialog && dialog.api === api && dialog.organizationId === organizationId && dialog.boxId === box.id && canManage
  return (
    <>
      <BoxNetworkPanel
        network={box.network}
        outboundDetails={
          user && organizationId ? (
            <BoxOutboundPolicy
              key={JSON.stringify([user.profile.iss, user.profile.sub, organizationId, box.id])}
              api={api}
              organizationId={organizationId}
              boxId={box.id}
              accessToken={user.access_token}
            />
          ) : (
            <span>Policy unavailable</span>
          )
        }
        inboundPending={toggleInbound.isPending}
        canManage={canManage}
        onToggleInbound={setInbound}
        onCreateTunnel={open}
      >
        {children}
      </BoxNetworkPanel>
      <BoxDomainBindings boxId={box.id} canManage={canManage} />
      {active && (
        <BoxTunnelDialog
          api={api}
          organizationId={dialog.organizationId}
          box={box}
          onClose={() => setDialog(null)}
          onEnableInbound={(signal) => toggleInbound.mutateAsync({ boxId: box.id, mode: NetworkMode.ENABLED, signal })}
          onRefreshInbound={async (signal) => {
            const { data } = await api.boxApi.getBox(box.id, dialog.organizationId, undefined, {
              signal,
              timeout: 15_000,
            })
            if (signal.aborted) return undefined
            queryClient.setQueryData(queryKeys.boxes.detail(dialog.organizationId, box.id), data)
            return data.network?.inbound.mode
          }}
        />
      )}
    </>
  )
}
