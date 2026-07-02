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

const DEFAULT_API_KEY_PERMISSIONS = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap((group) => group.permissions)

const Keys: React.FC = () => {
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
    return DEFAULT_API_KEY_PERMISSIONS.filter((permission) => assignedPermissions.has(permission))
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
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-[34px] pt-[26px] lg:px-[40px]">
      {/* header — same hierarchy as the Boxes page */}
      <div className="mb-[22px] flex items-end justify-between">
        <h1 className="font-mono text-[22px] font-medium leading-none tracking-[-0.5px]">API Keys</h1>
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
