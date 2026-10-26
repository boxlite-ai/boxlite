/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateOrganizationInvitationDialog } from '@/components/OrganizationMembers/CreateOrganizationInvitationDialog'
import { OrganizationMemberTable } from '@/components/OrganizationMembers/OrganizationMemberTable'
import { useApi } from '@/hooks/useApi'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import {
  CreateOrganizationInvitationRoleEnum,
  OrganizationInvitation,
  OrganizationUserRoleEnum,
} from '@boxlite-ai/api-client'
import React, { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'

const OrganizationMembers: React.FC = () => {
  const { user } = useAuth()
  const { organizationsApi } = useApi()

  const { refreshOrganizations } = useOrganizations()
  const { selectedOrganization, organizationMembers, refreshOrganizationMembers, authenticatedUserOrganizationMember } =
    useSelectedOrganization()
  const authenticatedUserIsOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  const [loadingMembers, setLoadingMembers] = useState(true)
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([])
  const [loadingInvitations, setLoadingInvitations] = useState(true)

  const [loadingMemberAction, setLoadingMemberAction] = useState<Record<string, boolean>>({})
  const [loadingInvitationAction, setLoadingInvitationAction] = useState<Record<string, boolean>>({})

  const fetchInvitations = useCallback(
    async (showTableLoadingState = true) => {
      if (!selectedOrganization || !authenticatedUserIsOwner) {
        setInvitations([])
        setLoadingInvitations(false)
        return
      }
      if (showTableLoadingState) {
        setLoadingInvitations(true)
      }
      try {
        const response = await organizationsApi.listOrganizationInvitations(selectedOrganization.id)
        setInvitations(response.data)
      } catch (error) {
        handleApiError(error, 'Failed to fetch invitations')
      } finally {
        setLoadingInvitations(false)
      }
    },
    [organizationsApi, selectedOrganization, authenticatedUserIsOwner],
  )

  useEffect(() => {
    // A failed load already shows a toast: getOrganizationMembers calls handleApiError and
    // rethrows, so this catch only keeps the rethrow from becoming an unhandled rejection.
    refreshOrganizationMembers()
      .catch(() => undefined)
      .finally(() => setLoadingMembers(false))
    fetchInvitations()
  }, [fetchInvitations, refreshOrganizationMembers])

  const handleRemoveMember = async (userId: string): Promise<boolean> => {
    if (!selectedOrganization) {
      return false
    }
    setLoadingMemberAction((prev) => ({ ...prev, [userId]: true }))
    try {
      await organizationsApi.deleteOrganizationMember(selectedOrganization.id, userId)
      toast.success('Member removed successfully')
      if (userId === user?.profile.sub) {
        await refreshOrganizations()
      } else {
        await refreshOrganizationMembers()
      }
      return true
    } catch (error) {
      handleApiError(error, 'Failed to remove member')
      return false
    } finally {
      setLoadingMemberAction((prev) => ({ ...prev, [userId]: false }))
    }
  }

  // Members carry no roles yet, so every invitee joins as an owner.
  const handleCreateInvitation = async (email: string): Promise<boolean> => {
    if (!selectedOrganization) {
      return false
    }
    try {
      await organizationsApi.createOrganizationInvitation(selectedOrganization.id, {
        email,
        role: CreateOrganizationInvitationRoleEnum.OWNER,
        assignedRoleIds: [],
      })
      toast.success('Invitation created successfully')
      await fetchInvitations(false)
      return true
    } catch (error) {
      handleApiError(error, 'Failed to create invitation')
      return false
    }
  }

  const handleResendInvitation = async (invitation: OrganizationInvitation): Promise<boolean> => {
    if (!selectedOrganization) return false
    setLoadingInvitationAction((prev) => ({ ...prev, [invitation.id]: true }))
    try {
      // Keep the expired record until its replacement exists; omit expiresAt to use the current default lifetime.
      await organizationsApi.createOrganizationInvitation(selectedOrganization.id, {
        email: invitation.email,
        role: invitation.role,
        assignedRoleIds: invitation.assignedRoles.map((role) => role.id),
      })
      try {
        await organizationsApi.cancelOrganizationInvitation(selectedOrganization.id, invitation.id)
      } catch (error) {
        handleApiError(error, 'New invitation created, but failed to remove the expired invitation')
      }
      toast.success('New invitation created')
      await fetchInvitations(false)
      return true
    } catch (error) {
      handleApiError(error, 'Failed to resend invitation')
      return false
    } finally {
      setLoadingInvitationAction((prev) => ({ ...prev, [invitation.id]: false }))
    }
  }

  const handleCancelInvitation = async (invitationId: string): Promise<boolean> => {
    if (!selectedOrganization) {
      return false
    }
    setLoadingInvitationAction((prev) => ({ ...prev, [invitationId]: true }))
    try {
      await organizationsApi.cancelOrganizationInvitation(selectedOrganization.id, invitationId)
      toast.success('Invitation cancelled successfully')
      await fetchInvitations(false)
      return true
    } catch (error) {
      handleApiError(error, 'Failed to cancel invitation')
      return false
    } finally {
      setLoadingInvitationAction((prev) => ({ ...prev, [invitationId]: false }))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Manage organization members and pending invitations.</p>
        {authenticatedUserIsOwner && (
          <CreateOrganizationInvitationDialog className="ml-auto" onCreateInvitation={handleCreateInvitation} />
        )}
      </div>

      <OrganizationMemberTable
        data={organizationMembers}
        invitations={invitations}
        loadingData={loadingMembers || (authenticatedUserIsOwner && loadingInvitations)}
        onRemoveMember={handleRemoveMember}
        loadingMemberAction={loadingMemberAction}
        ownerMode={authenticatedUserIsOwner}
        onCancelInvitation={handleCancelInvitation}
        onResendInvitation={handleResendInvitation}
        loadingInvitationAction={loadingInvitationAction}
      />
    </div>
  )
}

export default OrganizationMembers
