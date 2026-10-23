/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { APPS_SCOPE } from '@/hooks/queries/useAppsQuery'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { appsClient } from '@/lib/apps/client'
import { relTime } from '@/lib/apps/format'
import type { AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useConfirm } from './confirm'
import { Disclosure } from './spec'
import { ToolButton } from './SubNav'

// The App's active keys, one per agent setup: never the key, only its last 4 characters, when it
// was made and last used, so one agent can be cut off without the others (Rotate key cuts off all).

interface AppKey {
  id: string
  last4: string
  created_at: string
  last_used_at: string | null
}

export function AppKeys({ app }: { app: AppDetail }) {
  const queryClient = useQueryClient()
  const key = [...queryKeys.apps.all, APPS_SCOPE, 'keys', app.id]
  const { data: keys = [] } = useQuery<AppKey[]>({
    queryKey: key,
    queryFn: async () => (await appsClient.get<AppKey[]>(`/apps/${encodeURIComponent(app.id)}/keys`)).data,
  })
  const revoke = useMutation({
    mutationFn: async (id: string) =>
      appsClient.delete(`/apps/${encodeURIComponent(app.id)}/keys/${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  })
  const [confirm, confirmElement] = useConfirm()
  const ask = async (k: AppKey) => {
    const ok = await confirm({
      title: `Revoke the key …${k.last4}?`,
      body: <>The agent using it loses access to {app.name} now. Agents with other keys keep working.</>,
      confirmLabel: 'Revoke key',
      danger: true,
    })
    if (!ok) return
    try {
      await revoke.mutateAsync(k.id)
      toast.success(`Key …${k.last4} revoked`)
    } catch (error) {
      handleApiError(error, 'Could not revoke the key')
    }
  }
  return (
    <Disclosure label={`Active keys (${keys.length})`}>
      <div className="flex flex-col font-mono text-[12px]">
        {keys.map((k) => (
          <div key={k.id} className="flex items-center gap-4 border-b border-border/60 py-2 last:border-b-0">
            <span className="text-foreground">…{k.last4}</span>
            <span className="text-muted-foreground">made {relTime(k.created_at)}</span>
            <span className="text-muted-foreground">
              {k.last_used_at ? `last used ${relTime(k.last_used_at)}` : 'not used yet'}
            </span>
            <span className="ml-auto">
              <ToolButton danger loading={revoke.isPending && revoke.variables === k.id} onClick={() => void ask(k)}>
                Revoke
              </ToolButton>
            </span>
          </div>
        ))}
      </div>
      {confirmElement}
    </Disclosure>
  )
}
