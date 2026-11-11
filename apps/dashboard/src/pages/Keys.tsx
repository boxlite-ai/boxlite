/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyDialog } from '@/components/CreateApiKeyDialog'
import { CREATE_API_KEY_PERMISSIONS_GROUPS } from '@/constants/CreateApiKeyPermissionsGroups'
import { useRevokeApiKeyMutation } from '@/hooks/mutations/useRevokeApiKeyMutation'
import { useApiKeysQuery } from '@/hooks/queries/useApiKeysQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { ApiKeyList, CreateApiKeyPermissionsEnum, OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ApiKeyTable } from '../components/ApiKeyTable'
import { usePageTitle } from '@/hooks/usePageTitle'

const DEFAULT_API_KEY_PERMISSIONS = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap((group) => group.permissions)

/** Lists the selected organization’s keys and limits creation options to the member’s assigned permissions. */
const Keys: React.FC = () => {
  usePageTitle('API keys')
  const { apiUrl } = useConfig()
  const [loadingKeys, setLoadingKeys] = useState<Record<string, boolean>>({})

  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const revokeApiKeyMutation = useRevokeApiKeyMutation()
  const apiKeysQuery = useApiKeysQuery(selectedOrganization?.id)

  const availablePermissions = useMemo<CreateApiKeyPermissionsEnum[]>(() => {
    if (!authenticatedUserOrganizationMember) {
      return []
    }
    if (authenticatedUserOrganizationMember.role === OrganizationUserRoleEnum.OWNER) {
      return DEFAULT_API_KEY_PERMISSIONS
    }
    const assignedPermissions = new Set(
      authenticatedUserOrganizationMember.assignedRoles.flatMap((role) => role.permissions),
    )
    return DEFAULT_API_KEY_PERMISSIONS.filter(
      (permission) => permission !== CreateApiKeyPermissionsEnum.WRITE_MEMBERS && assignedPermissions.has(permission),
    )
  }, [authenticatedUserOrganizationMember])

  const handleRevoke = async (key: ApiKeyList) => {
    if (!selectedOrganization) {
      return
    }
    const loadingId = getLoadingKeyId(key)
    setLoadingKeys((prev) => ({ ...prev, [loadingId]: true }))
    try {
      await revokeApiKeyMutation.mutateAsync({
        userId: key.userId,
        name: key.name,
        organizationId: selectedOrganization.id,
      })
      toast.success('API key revoked successfully')
    } catch (error) {
      handleApiError(error, 'Failed to revoke API key')
    } finally {
      setLoadingKeys((prev) => ({ ...prev, [loadingId]: false }))
    }
  }

  const getLoadingKeyId = useCallback((key: ApiKeyList) => {
    return `${key.userId}-${key.name}`
  }, [])

  const isLoadingKey = useCallback(
    (key: ApiKeyList) => {
      const loadingId = getLoadingKeyId(key)
      return loadingKeys[loadingId]
    },
    [getLoadingKeyId, loadingKeys],
  )

  return (
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col pt-[26px]">
      {/* header — same hierarchy as the Boxes page */}
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">API Keys</h1>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            Connect your apps, scripts, and SDKs to BoxLite.
          </p>
        </div>
      </div>
      <div className="mb-[14px] flex min-h-9 justify-end">
        <CreateApiKeyDialog
          availablePermissions={availablePermissions}
          apiUrl={apiUrl}
          organizationId={selectedOrganization?.id}
        />
      </div>

      <ApiKeyTable
        data={apiKeysQuery.data ?? []}
        loading={apiKeysQuery.isLoading || apiKeysQuery.isRefetching}
        isLoadingKey={isLoadingKey}
        onRevoke={handleRevoke}
      />
    </div>
  )
}

export default Keys
