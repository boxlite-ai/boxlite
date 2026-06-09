/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PlaygroundCategories } from '@/enums/Playground'
import { useDeepCompareMemo } from '@/hooks/useDeepCompareMemo'
import { usePlayground } from '@/hooks/usePlayground'
import { useSandboxSession, UseSandboxSessionResult } from '@/hooks/useSandboxSession'
import { createContext, useEffect, useRef } from 'react'

export const PlaygroundSandboxContext = createContext<UseSandboxSessionResult | null>(null)

export const PlaygroundSandboxProvider: React.FC<{
  activeTab: PlaygroundCategories
  vncEnabled: boolean
  children: React.ReactNode
}> = ({ activeTab, vncEnabled, children }) => {
  const { getSandboxParametersInfo } = usePlayground()
  const { createSandboxParams } = getSandboxParametersInfo()
  const stableCreateParams = useDeepCompareMemo(createSandboxParams)

  const session = useSandboxSession({
    scope: 'playground',
    createParams: stableCreateParams,
    terminal: true,
    vnc: vncEnabled,
    notify: { vnc: activeTab === PlaygroundCategories.VNC },
  })

  const createRef = useRef(session.sandbox.create)
  createRef.current = session.sandbox.create

  useEffect(() => {
    const needsSandbox =
      activeTab === PlaygroundCategories.TERMINAL || (vncEnabled && activeTab === PlaygroundCategories.VNC)
    if (needsSandbox && !session.sandbox.instance && !session.sandbox.loading && !session.sandbox.error) {
      createRef.current()
    }
  }, [activeTab, session.sandbox.instance, session.sandbox.loading, session.sandbox.error, vncEnabled])

  const vncSandboxId = useRef<string | null>(null)
  useEffect(() => {
    const id = session.sandbox.instance?.id
    if (vncEnabled && id && vncSandboxId.current !== id) {
      vncSandboxId.current = id
      session.vnc.start()
    }
  }, [session.sandbox.instance?.id, session.vnc, vncEnabled])

  return <PlaygroundSandboxContext.Provider value={session}>{children}</PlaygroundSandboxContext.Provider>
}
