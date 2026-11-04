/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { RoutePath } from '@/enums/RoutePath'
import { useAppsScope } from '@/lib/apps/client'
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

/** Forms and one-time credentials belong to the organization in which they were opened. */
export function OrganizationScope({ children }: { children: ReactNode }) {
  const { organizationId, canRead } = useAppsScope()
  const { pathname } = useLocation()
  const previous = useRef(organizationId)
  const changed = !!previous.current && previous.current !== organizationId
  useEffect(() => {
    previous.current = organizationId
  }, [organizationId])
  if (!organizationId) return <p className="p-6">Select an organization to view Apps.</p>
  if (!canRead)
    return (
      <p role="alert" className="p-6">
        You need App read permission to view Apps.
      </p>
    )
  if (changed && pathname !== RoutePath.APPS) return <Navigate to={RoutePath.APPS} replace />
  return <Fragment key={organizationId}>{children}</Fragment>
}
