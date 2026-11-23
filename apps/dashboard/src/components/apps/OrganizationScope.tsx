/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { AppHostingAccess } from './AppHostingAccess'
import { RoutePath } from '@/enums/RoutePath'
import { useAppsScope } from '@/lib/apps/client'
import { hasSeenAppHostingIntro, setAppHostingIntroSeen } from '@/lib/apps/intro'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

/** Open forms belong to the organization in which they were started. */
export function OrganizationScope({ children }: { children: ReactNode }) {
  const { organizationId, canRead } = useAppsScope()
  const { pathname } = useLocation()
  const [introSeen, setIntroSeen] = useState(hasSeenAppHostingIntro)
  const previous = useRef(organizationId)
  const changed = !!previous.current && previous.current !== organizationId
  useEffect(() => {
    previous.current = organizationId
  }, [organizationId])
  if (!organizationId) return <p className="p-6">Select an organization to view Apps.</p>
  if (!introSeen)
    return (
      <AppHostingAccess
        onContinue={() => {
          setAppHostingIntroSeen(true)
          setIntroSeen(true)
        }}
      />
    )
  if (!canRead)
    return (
      <p role="alert" className="p-6">
        You need App read permission to view Apps.
      </p>
    )
  if (changed && pathname !== RoutePath.APPS) return <Navigate to={RoutePath.APPS} replace />
  return <Fragment key={organizationId}>{children}</Fragment>
}
