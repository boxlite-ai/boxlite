/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { AxiosError } from 'axios'
import { useMemo } from 'react'

export function useAppsScope() {
  const api = useApi()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const organizationId = selectedOrganization?.id ?? ''
  const client = useMemo(() => api.cloudApps(organizationId), [api, organizationId])
  return {
    client,
    organizationId,
    canRead: authenticatedUserHasPermission(OrganizationRolePermissionsEnum.READ_APPS),
    canWrite: authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_APPS),
    canDelete: authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_APPS),
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function httpStatusOf(error: unknown): number | undefined {
  const cause = error instanceof Error && error.cause instanceof AxiosError ? error.cause : error
  return cause instanceof AxiosError ? cause.response?.status : undefined
}

export function errorBody(error: unknown): Record<string, unknown> | undefined {
  const cause = error instanceof Error && error.cause instanceof AxiosError ? error.cause : error
  if (!(cause instanceof AxiosError)) return undefined
  return (cause.response?.data as { error?: Record<string, unknown> } | undefined)?.error
}
