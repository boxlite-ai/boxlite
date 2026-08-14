/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useInfrastructureLogsAccess } from '@/hooks/useInfrastructureLogs'
import { ReactNode } from 'react'

interface InfrastructureLogsAccessGateProps {
  children: ReactNode
  denied?: ReactNode
  pending?: ReactNode
}

export function InfrastructureLogsAccessGate({
  children,
  denied = null,
  pending = null,
}: InfrastructureLogsAccessGateProps) {
  const access = useInfrastructureLogsAccess()

  if (access.isPending) return pending

  return access.data?.canRead ? children : denied
}
