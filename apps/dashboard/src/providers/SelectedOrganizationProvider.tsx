/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ISelectedOrganizationContext, SelectedOrganizationContext } from '@/contexts/SelectedOrganizationContext'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { useApi } from '@/hooks/useApi'
import { useOrganizationBoxLimitsQuery } from '@/hooks/queries/useOrganizationBoxLimitsQuery'
import { useOrganizations } from '@/hooks/useOrganizations'
import { handleApiError } from '@/lib/error-handling'
import {
  readOrganizationSession,
  saveOrganizationSession,
  ORGANIZATION_SESSION_EVENT,
} from '@/lib/organization-session'
import { resolveSelectedOrganizationId } from '@/lib/organization-selection'
import { organizationAllowsScope } from '@/lib/app-hosting-permissions'
import {
  Organization,
  OrganizationRolePermissionsEnum,
  OrganizationUser,
  OrganizationUserRoleEnum,
} from '@boxlite-ai/api-client'
import { usePostHog } from 'posthog-js/react'
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'

type Props = {
  children: ReactNode
}

export function SelectedOrganizationProvider(props: Props) {
  const { user } = useAuth()
  const { organizationsApi } = useApi()
  const posthog = usePostHog()

  const { organizations, refreshOrganizations } = useOrganizations()

  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(() =>
    resolveSelectedOrganizationId(organizations, readOrganizationSession(user?.profile.sub)),
  )

  useEffect(() => {
    if (!organizations.length) {
      setSelectedOrganizationId(null)
      return
    }

    const resolvedOrganizationId = resolveSelectedOrganizationId(organizations, selectedOrganizationId)
    if (resolvedOrganizationId && resolvedOrganizationId !== selectedOrganizationId) {
      setSelectedOrganizationId(resolvedOrganizationId)
    }
  }, [organizations, selectedOrganizationId])

  const selectedOrganization = useMemo<Organization | null>(() => {
    if (!selectedOrganizationId) {
      return null
    }
    return organizations.find((org) => org.id === selectedOrganizationId) || null
  }, [organizations, selectedOrganizationId])

  useOrganizationBoxLimitsQuery(selectedOrganization)

  useEffect(() => {
    if (!posthog || !selectedOrganizationId) {
      return
    }

    posthog.group('organization', selectedOrganizationId)
  }, [posthog, selectedOrganizationId])

  const getOrganizationMembers = useCallback(
    async (selectedOrganizationId: string | null) => {
      if (!selectedOrganizationId) {
        return []
      }
      try {
        return (await organizationsApi.listOrganizationMembers(selectedOrganizationId)).data
      } catch (error) {
        handleApiError(error, 'Failed to fetch organization members')
        throw error
      }
    },
    [organizationsApi],
  )

  // Members are only needed for permission checks (Create/Delete buttons), not
  // for first paint. Fetching them here used to suspend() the whole dashboard
  // subtree for ~0.75s before the boxes table could mount. Load them in the
  // background instead: the table renders immediately; permission-gated actions
  // default to disabled (authenticatedUserHasPermission returns false on an
  // empty list) until members arrive.
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationUser[]>([])

  const [membersLoad, setMembersLoad] = useState<{
    organizationId: string | null
    status: 'loading' | 'ready' | 'error'
  }>({ organizationId: null, status: 'loading' })
  const membersRequest = useRef(0)
  const currentOrganizationId = useRef(selectedOrganizationId)
  currentOrganizationId.current = selectedOrganizationId
  const organizationMembersStatus =
    membersLoad.organizationId === selectedOrganizationId ? membersLoad.status : 'loading'

  const refreshOrganizationMembers = useCallback(
    async (organizationId?: string) => {
      const target = organizationId || selectedOrganizationId
      // Requests for another organization must not invalidate the active context.
      const request = target === currentOrganizationId.current ? ++membersRequest.current : null
      const isCurrent = () => request === membersRequest.current && currentOrganizationId.current === target
      if (isCurrent()) {
        setMembersLoad((previous) =>
          previous.organizationId === target && previous.status === 'ready'
            ? previous
            : { organizationId: target, status: 'loading' },
        )
      }
      try {
        const members = await getOrganizationMembers(target)
        if (isCurrent()) {
          setOrganizationMembers(members)
          setMembersLoad({ organizationId: target, status: 'ready' })
        }
        return members
      } catch (error) {
        if (isCurrent()) setMembersLoad({ organizationId: target, status: 'error' })
        throw error
      }
    },
    [getOrganizationMembers, selectedOrganizationId],
  )

  useEffect(() => {
    // The API helper reports the error; readiness exposes a retry without crashing the page.
    void refreshOrganizationMembers().catch(() => undefined)
    return () => {
      membersRequest.current += 1
    }
  }, [refreshOrganizationMembers])

  const authenticatedUserOrganizationMember = useMemo(() => {
    return organizationMembers.find((member) => member.userId === user?.profile.sub) || null
  }, [organizationMembers, user])

  const authenticatedUserAssignedPermissions = useMemo(() => {
    if (!authenticatedUserOrganizationMember) {
      return null
    }
    return new Set(authenticatedUserOrganizationMember.assignedRoles.flatMap((role) => role.permissions))
  }, [authenticatedUserOrganizationMember])

  const authenticatedUserHasPermission = useCallback(
    (permission: OrganizationRolePermissionsEnum) => {
      if (
        permission.endsWith(':apps') &&
        (organizationMembersStatus !== 'ready' ||
          !organizationAllowsScope(permission, selectedOrganization?.appHostingPermissions))
      )
        return false
      if (!authenticatedUserOrganizationMember || !authenticatedUserAssignedPermissions) {
        return false
      }
      if (
        authenticatedUserOrganizationMember.role === OrganizationUserRoleEnum.OWNER ||
        (permission.endsWith(':apps') && authenticatedUserOrganizationMember.isSystemAdmin)
      ) {
        return true
      }
      return authenticatedUserAssignedPermissions.has(permission)
    },
    [
      authenticatedUserOrganizationMember,
      authenticatedUserAssignedPermissions,
      organizationMembersStatus,
      selectedOrganization,
    ],
  )

  const refreshing = useRef<{ id: string; promise: Promise<void> } | null>(null)
  const refreshOrganizationPermissions = useCallback(
    async (organizationId: string) => {
      if (organizationId !== currentOrganizationId.current) return
      if (refreshing.current?.id === organizationId) return refreshing.current.promise
      const promise = Promise.all([refreshOrganizations(), refreshOrganizationMembers(organizationId)]).then(
        () => undefined,
      )
      refreshing.current = { id: organizationId, promise }
      try {
        await promise
      } finally {
        if (refreshing.current?.promise === promise) refreshing.current = null
      }
    },
    [refreshOrganizations, refreshOrganizationMembers],
  )

  const handleSelectOrganization = useCallback(
    async (organizationId: string): Promise<boolean> => {
      const [organizationMembers] = await Promise.all([getOrganizationMembers(organizationId), refreshOrganizations()])

      // confirm switch if user is a member of the new organization
      if (organizationMembers.some((member) => member.userId === user?.profile.sub)) {
        saveOrganizationSession(user!.profile.sub, organizationId)
        try {
          localStorage.setItem(LocalStorageKey.SelectedOrganizationId, organizationId)
        } catch {
          /* The session record is authoritative; this is only a compatibility hint. */
        }
        setOrganizationMembers(organizationMembers)
        window.dispatchEvent(new Event(ORGANIZATION_SESSION_EVENT))
        setSelectedOrganizationId(organizationId)
        return true
      } else {
        toast.error('Failed to switch organization', {
          closeButton: true,
        })
        return false
      }
    },
    [getOrganizationMembers, refreshOrganizations, user],
  )

  const contextValue: ISelectedOrganizationContext = useMemo(() => {
    return {
      selectedOrganization,
      organizationMembers,
      organizationMembersStatus,
      refreshOrganizationMembers,
      refreshOrganizationPermissions,
      authenticatedUserOrganizationMember,
      authenticatedUserHasPermission,
      onSelectOrganization: handleSelectOrganization,
    }
  }, [
    selectedOrganization,
    organizationMembers,
    organizationMembersStatus,
    authenticatedUserOrganizationMember,
    authenticatedUserHasPermission,
    handleSelectOrganization,
    refreshOrganizationMembers,
    refreshOrganizationPermissions,
  ])

  return (
    <SelectedOrganizationContext.Provider value={contextValue}>{props.children}</SelectedOrganizationContext.Provider>
  )
}
