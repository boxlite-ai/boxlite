/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IBoxSessionContext, BoxSessionContext } from '@/contexts/BoxSessionContext'
import { ReactNode, useCallback, useRef } from 'react'

type SessionFlags = { terminal: boolean; vnc: boolean }

export function BoxSessionProvider({ children }: { children: ReactNode }) {
  const flagsRef = useRef<Map<string, SessionFlags>>(new Map())

  const getFlags = useCallback((boxId: string): SessionFlags => {
    let flags = flagsRef.current.get(boxId)
    if (!flags) {
      flags = { terminal: false, vnc: false }
      flagsRef.current.set(boxId, flags)
    }
    return flags
  }, [])

  const value: IBoxSessionContext = {
    isTerminalActivated: (boxId) => getFlags(boxId).terminal,
    activateTerminal: (boxId) => {
      getFlags(boxId).terminal = true
    },
    isVncActivated: (boxId) => getFlags(boxId).vnc,
    activateVnc: (boxId) => {
      getFlags(boxId).vnc = true
    },
  }

  return <BoxSessionContext.Provider value={value}>{children}</BoxSessionContext.Provider>
}
