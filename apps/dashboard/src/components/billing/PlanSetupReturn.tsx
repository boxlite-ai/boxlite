/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { useLocation, useNavigate } from 'react-router-dom'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { RoutePath } from '@/enums/RoutePath'
import { consumePlanSetup } from './planSetupIntent'

/** Restore navigation only. The confirmation page owns fresh reads and explicit submission. */
export function PlanSetupReturn() {
  const { user } = useAuth()
  const { selectedOrganization, authenticatedUserOrganizationMember, organizationMembersStatus } =
    useSelectedOrganization()
  const navigate = useNavigate()
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  // Commerce returns to the bare Billing entry. Explicit destinations take priority.
  const returnLanding = !search.has('tab') && !search.has('code')
  const subject = user?.profile.sub
  const organizationId = selectedOrganization?.id
  const owner =
    organizationMembersStatus === 'ready' &&
    authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  useEffect(() => {
    if (!returnLanding || !subject || !organizationId || !owner) return
    const planId = consumePlanSetup(subject, organizationId, true)
    if (planId) navigate(`${RoutePath.BILLING_PLAN}/${encodeURIComponent(planId)}?setup=return`, { replace: true })
  }, [subject, organizationId, owner, navigate, returnLanding])
  return null
}
