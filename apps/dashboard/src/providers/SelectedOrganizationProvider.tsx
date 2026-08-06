/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ISelectedOrganizationContext, SelectedOrganizationContext } from '@/contexts/SelectedOrganizationContext'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { useApi } from '@/hooks/useApi'
import { useOrganizations } from '@/hooks/useOrganizations'
import { handleApiError } from '@/lib/error-handling'
import { resolveSelectedOrganizationId } from '@/lib/organization-selection'
import {
  Organization,
  OrganizationRolePermissionsEnum,
  OrganizationUser,
  OrganizationUserRoleEnum,
} from '@boxlite-ai/api-client'
import { usePostHog } from 'posthog-js/react'
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'

type Props = {
  children: ReactNode
}

const EMPTY_ORGANIZATION_MEMBERS: OrganizationUser[] = []

interface OrganizationMembersState {
  organizationId: string | null
  members: OrganizationUser[]
  loaded: boolean
}

export function SelectedOrganizationProvider(props: Props) {
  const { user } = useAuth()
  const { organizationsApi } = useApi()
  const posthog = usePostHog()

  const { organizations } = useOrganizations()

  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(() => {
    const storedId = localStorage.getItem(LocalStorageKey.SelectedOrganizationId)
    const resolvedOrganizationId = resolveSelectedOrganizationId(organizations, storedId)
    if (resolvedOrganizationId) {
      localStorage.setItem(LocalStorageKey.SelectedOrganizationId, resolvedOrganizationId)
      return resolvedOrganizationId
    }

    localStorage.removeItem(LocalStorageKey.SelectedOrganizationId)
    return null
  })

  useEffect(() => {
    if (!organizations.length) {
      setSelectedOrganizationId(null)
      localStorage.removeItem(LocalStorageKey.SelectedOrganizationId)
      return
    }

    const resolvedOrganizationId = resolveSelectedOrganizationId(organizations, selectedOrganizationId)
    if (resolvedOrganizationId && resolvedOrganizationId !== selectedOrganizationId) {
      localStorage.setItem(LocalStorageKey.SelectedOrganizationId, resolvedOrganizationId)
      setSelectedOrganizationId(resolvedOrganizationId)
    }
  }, [organizations, selectedOrganizationId])

  const selectedOrganization = useMemo<Organization | null>(() => {
    if (!selectedOrganizationId) {
      return null
    }
    return organizations.find((org) => org.id === selectedOrganizationId) || null
  }, [organizations, selectedOrganizationId])

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
  // Keep membership data attached to the organization it was fetched for.
  // selectedOrganizationId can change because the organizations list refreshes,
  // not only through handleSelectOrganization. Without the id, that render can
  // expose the previous org's loaded OWNER membership to billing hooks for the
  // newly selected org before this effect has a chance to clear it.
  const [organizationMembersState, setOrganizationMembersState] = useState<OrganizationMembersState>({
    organizationId: selectedOrganizationId,
    members: EMPTY_ORGANIZATION_MEMBERS,
    loaded: false,
  })
  const organizationMembers =
    organizationMembersState.organizationId === selectedOrganizationId
      ? organizationMembersState.members
      : EMPTY_ORGANIZATION_MEMBERS
  const organizationMembersLoaded =
    organizationMembersState.organizationId === selectedOrganizationId && organizationMembersState.loaded

  useEffect(() => {
    let cancelled = false
    setOrganizationMembersState({
      organizationId: selectedOrganizationId,
      members: EMPTY_ORGANIZATION_MEMBERS,
      loaded: false,
    })
    getOrganizationMembers(selectedOrganizationId)
      .then((members) => {
        if (!cancelled) {
          setOrganizationMembersState({
            organizationId: selectedOrganizationId,
            members,
            loaded: true,
          })
        }
      })
      // getOrganizationMembers already surfaces a toast via handleApiError; a
      // members failure must not crash the dashboard (was: error boundary).
      .catch(() => {
        if (!cancelled) {
          setOrganizationMembersState({
            organizationId: selectedOrganizationId,
            members: EMPTY_ORGANIZATION_MEMBERS,
            loaded: true,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [getOrganizationMembers, selectedOrganizationId])

  const refreshOrganizationMembers = useCallback(
    async (organizationId?: string) => {
      const targetOrganizationId = organizationId || selectedOrganizationId
      const organizationMembers = await getOrganizationMembers(targetOrganizationId)
      setOrganizationMembersState({
        organizationId: targetOrganizationId,
        members: organizationMembers,
        loaded: true,
      })
      return organizationMembers
    },
    [getOrganizationMembers, selectedOrganizationId],
  )

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
      if (!authenticatedUserOrganizationMember || !authenticatedUserAssignedPermissions) {
        return false
      }
      if (authenticatedUserOrganizationMember.role === OrganizationUserRoleEnum.OWNER) {
        return true
      }
      return authenticatedUserAssignedPermissions.has(permission)
    },
    [authenticatedUserOrganizationMember, authenticatedUserAssignedPermissions],
  )

  const handleSelectOrganization = useCallback(
    async (organizationId: string): Promise<boolean> => {
      const organizationMembers = await refreshOrganizationMembers(organizationId)

      // confirm switch if user is a member of the new organization
      if (organizationMembers.some((member) => member.userId === user?.profile.sub)) {
        localStorage.setItem(LocalStorageKey.SelectedOrganizationId, organizationId)
        setSelectedOrganizationId(organizationId)
        return true
      } else {
        toast.error('Failed to switch organization', {
          closeButton: true,
        })
        return false
      }
    },
    [refreshOrganizationMembers, user],
  )

  const contextValue: ISelectedOrganizationContext = useMemo(() => {
    return {
      selectedOrganization,
      organizationMembers,
      organizationMembersLoaded,
      refreshOrganizationMembers,
      authenticatedUserOrganizationMember,
      authenticatedUserHasPermission,
      onSelectOrganization: handleSelectOrganization,
    }
  }, [
    selectedOrganization,
    organizationMembers,
    organizationMembersLoaded,
    authenticatedUserOrganizationMember,
    authenticatedUserHasPermission,
    handleSelectOrganization,
    refreshOrganizationMembers,
  ])

  return (
    <SelectedOrganizationContext.Provider value={contextValue}>{props.children}</SelectedOrganizationContext.Provider>
  )
}
