/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PlaygroundCategories } from '@/enums/Playground'
import { useDeepCompareMemo } from '@/hooks/useDeepCompareMemo'
import { usePlayground } from '@/hooks/usePlayground'
import { useBoxSession, UseBoxSessionResult } from '@/hooks/useBoxSession'
import { createContext, useEffect, useRef } from 'react'

export const PlaygroundBoxContext = createContext<UseBoxSessionResult | null>(null)

export const PlaygroundBoxProvider: React.FC<{
  activeTab: PlaygroundCategories
  vncEnabled: boolean
  children: React.ReactNode
}> = ({ activeTab, vncEnabled, children }) => {
  const { getBoxParametersInfo } = usePlayground()
  const { createBoxParams } = getBoxParametersInfo()
  const stableCreateParams = useDeepCompareMemo(createBoxParams)

  const session = useBoxSession({
    scope: 'playground',
    createParams: stableCreateParams,
    terminal: true,
    vnc: vncEnabled,
    notify: { vnc: activeTab === PlaygroundCategories.VNC },
  })

  const createRef = useRef(session.box.create)
  createRef.current = session.box.create

  useEffect(() => {
    const needsBox =
      activeTab === PlaygroundCategories.TERMINAL || (vncEnabled && activeTab === PlaygroundCategories.VNC)
    if (needsBox && !session.box.instance && !session.box.loading && !session.box.error) {
      createRef.current()
    }
  }, [activeTab, session.box.instance, session.box.loading, session.box.error, vncEnabled])

  const vncBoxId = useRef<string | null>(null)
  useEffect(() => {
    const id = session.box.instance?.id
    if (vncEnabled && id && vncBoxId.current !== id) {
      vncBoxId.current = id
      session.vnc.start()
    }
  }, [session.box.instance?.id, session.vnc, vncEnabled])

  return <PlaygroundBoxContext.Provider value={session}>{children}</PlaygroundBoxContext.Provider>
}
