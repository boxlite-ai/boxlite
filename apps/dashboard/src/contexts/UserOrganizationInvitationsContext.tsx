/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createContext } from 'react'

export interface IUserOrganizationInvitationsContext {
  count: number
  setCount(count: number): void
}

export const UserOrganizationInvitationsContext = createContext<IUserOrganizationInvitationsContext | undefined>(
  undefined,
)
