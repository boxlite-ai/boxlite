/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { AppHostingAccess } from './AppHostingAccess'
import { RoutePath } from '@/enums/RoutePath'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { organizationAllowsScope } from '@/lib/app-hosting-permissions'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

/** Open forms belong to the organization in which they were started. */
export function OrganizationScope({ children }: { children: ReactNode }) {
  const { selectedOrganization, authenticatedUserHasPermission, organizationMembersStatus } = useSelectedOrganization()
  const organizationId = selectedOrganization?.id
  const { pathname } = useLocation()
  const previous = useRef(organizationId)
  const changed = !!previous.current && previous.current !== organizationId
  useEffect(() => {
    previous.current = organizationId
  }, [organizationId])
  if (!selectedOrganization) return <p className="p-6">Select an organization to view Apps.</p>
  if (changed && pathname !== RoutePath.APPS) return <Navigate to={RoutePath.APPS} replace />
  const readApps = OrganizationRolePermissionsEnum.READ_APPS
  if (!organizationAllowsScope(readApps, selectedOrganization.appHostingPermissions))
    return <AppHostingAccess key={selectedOrganization.id} organizationId={selectedOrganization.id} />
  if (organizationMembersStatus === 'loading') return <p className="p-6">Loading App permissions…</p>
  if (organizationMembersStatus === 'error')
    return (
      <p role="alert" className="p-6">
        Unable to load App permissions. Refresh the page to try again.
      </p>
    )
  if (!authenticatedUserHasPermission(readApps))
    return (
      <p role="alert" className="p-6">
        Ask your organization administrator for App read permission to view Apps.
      </p>
    )
  return <Fragment key={organizationId}>{children}</Fragment>
}
