/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createContext } from 'react'

export interface IBoxSessionContext {
  isTerminalActivated: (boxId: string) => boolean
  activateTerminal: (boxId: string) => void
  isVncActivated: (boxId: string) => boolean
  activateVnc: (boxId: string) => void
}

export const BoxSessionContext = createContext<IBoxSessionContext | null>(null)
