/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import React, { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

const MEMBER_PAGE = `${RoutePath.SETTINGS}?tab=member`

// Keep the delivered email URL, but no longer expose a personal invitation list.
const UserOrganizationInvitations: React.FC = () => {
  const { organizationsApi } = useApi()
  const { refreshOrganizations } = useOrganizations()
  const { onSelectOrganization } = useSelectedOrganization()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const invitationId = searchParams.get('id')
  const attemptedLinks = useRef(new Set<string>())
  const [status, setStatus] = useState<'joining' | 'failed' | 'switch-failed'>('joining')

  useEffect(() => {
    if (!invitationId || attemptedLinks.current.has(invitationId)) return
    // Effects can replay; accepting a link must issue only one mutation per visit.
    attemptedLinks.current.add(invitationId)
    setStatus('joining')

    const joinOrganization = async () => {
      let invitation
      try {
        const response = await organizationsApi.acceptOrganizationInvitation(invitationId)
        invitation = response.data
      } catch (error) {
        handleApiError(error, 'Failed to accept invitation')
        setStatus('failed')
        return
      }

      toast.success(`You joined ${invitation.organizationName}`)
      // Membership already exists. A failed switch must not be reported as a failed accept.
      try {
        await refreshOrganizations()
        if (!(await onSelectOrganization(invitation.organizationId))) {
          setStatus('switch-failed')
          return
        }
        navigate(MEMBER_PAGE, { replace: true })
      } catch (error) {
        handleApiError(error, 'Failed to switch to the joined organization')
        setStatus('switch-failed')
      }
    }

    void joinOrganization()
  }, [invitationId, organizationsApi, refreshOrganizations, onSelectOrganization, navigate])

  if (!invitationId) return <Navigate to={MEMBER_PAGE} replace />

  return (
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Join organization</PageTitle>
      </PageHeader>
      <PageContent size="full">
        {status === 'joining' && <p role="status">Joining organization...</p>}
        {status === 'failed' && (
          <p role="alert" className="text-sm text-destructive">
            Unable to join using this invitation. Sign in with the invited email address, or ask the organization owner
            for a new invitation.
          </p>
        )}
        {status === 'switch-failed' && (
          <p role="alert" className="text-sm text-destructive">
            You joined the organization, but we could not open it. Use the profile menu to switch organizations.
          </p>
        )}
      </PageContent>
    </PageLayout>
  )
}

export default UserOrganizationInvitations
