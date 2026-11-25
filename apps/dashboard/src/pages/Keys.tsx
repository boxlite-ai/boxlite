/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyDialog } from '@/components/CreateApiKeyDialog'
import {
  ResourceFilter,
  ResourceLoadingState,
  ResourceErrorState,
  ResourceErrorNotice,
} from '@/components/ResourceLayout'
import { useRevokeApiKeyMutation } from '@/hooks/mutations/useRevokeApiKeyMutation'
import { useApiKeysQuery } from '@/hooks/queries/useApiKeysQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { SUPPORTED_API_KEY_PERMISSIONS } from '@/lib/api-key-permissions'
import { handleApiError } from '@/lib/error-handling'
import { ApiKeyList, CreateApiKeyPermissionsEnum, OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from 'react-oidc-context'
import { ApiKeyTable } from '../components/ApiKeyTable'
import { usePageTitle } from '@/hooks/usePageTitle'
import { organizationAllowsScope } from '@/lib/app-hosting-permissions'

/** Lists the selected organization’s keys and limits creation options to the member’s assigned permissions. */
const Keys: React.FC = () => {
  usePageTitle('API keys')
  const { user } = useAuth()
  const { apiUrl } = useConfig()
  const [loadingKeys, setLoadingKeys] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState('')

  const {
    selectedOrganization,
    authenticatedUserOrganizationMember,
    organizationMembersStatus,
    refreshOrganizationPermissions,
  } = useSelectedOrganization()
  const revokeApiKeyMutation = useRevokeApiKeyMutation()
  const apiKeysQuery = useApiKeysQuery(selectedOrganization?.id)
  const needle = filter.trim().toLowerCase()
  const filteredKeys = (apiKeysQuery.data ?? []).filter((key) => key.name.toLowerCase().includes(needle))

  const availablePermissions = useMemo<CreateApiKeyPermissionsEnum[]>(() => {
    if (!authenticatedUserOrganizationMember) {
      return []
    }
    const supported = SUPPORTED_API_KEY_PERMISSIONS.filter((scope) =>
      organizationAllowsScope(scope, selectedOrganization?.appHostingPermissions),
    )
    if (authenticatedUserOrganizationMember.role === OrganizationUserRoleEnum.OWNER) {
      return supported
    }
    const assignedPermissions = new Set(
      authenticatedUserOrganizationMember.assignedRoles.flatMap((role) => role.permissions),
    )
    return supported.filter(
      (permission) =>
        (permission.endsWith(':apps') && authenticatedUserOrganizationMember.isSystemAdmin) ||
        (permission !== CreateApiKeyPermissionsEnum.WRITE_MEMBERS && assignedPermissions.has(permission)),
    )
  }, [authenticatedUserOrganizationMember, selectedOrganization])

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
      <div className="resource-page-header">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">API Keys</h1>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            Connect your apps, scripts, and SDKs to BoxLite.
          </p>
        </div>
      </div>
      <div className="resource-toolbar mb-[14px]">
        <ResourceFilter
          label="Filter API keys"
          value={filter}
          onChange={setFilter}
          count={apiKeysQuery.data ? filteredKeys.length : '—'}
          disabled={!apiKeysQuery.data}
        />
        <div className="flex-1" />
        <CreateApiKeyDialog
          key={`${selectedOrganization?.id}:${user?.profile.sub}`}
          organizationName={selectedOrganization?.name}
          permissionsStatus={organizationMembersStatus ?? (authenticatedUserOrganizationMember ? 'ready' : 'loading')}
          onRetryPermissions={async () => {
            if (selectedOrganization) await refreshOrganizationPermissions(selectedOrganization.id)
          }}
          availablePermissions={availablePermissions}
          apiUrl={apiUrl}
          organizationId={selectedOrganization?.id}
        />
      </div>

      <div className="resource-content">
        {apiKeysQuery.data === undefined ? (
          apiKeysQuery.isError ? (
            <ResourceErrorState
              title="Could not load API keys"
              retrying={apiKeysQuery.isFetching}
              onRetry={() => void apiKeysQuery.refetch()}
            />
          ) : (
            <ResourceLoadingState title="Loading API keys…" />
          )
        ) : (
          <>
            {apiKeysQuery.isError && (
              <ResourceErrorNotice
                title="Could not refresh API keys. Showing previously loaded data."
                retrying={apiKeysQuery.isFetching}
                onRetry={() => void apiKeysQuery.refetch()}
              />
            )}
            <ApiKeyTable
              appHostingPermissions={selectedOrganization?.appHostingPermissions ?? []}
              data={filteredKeys}
              onClearFilter={needle ? () => setFilter('') : undefined}
              loading={false}
              isLoadingKey={isLoadingKey}
              onRevoke={handleRevoke}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default Keys
