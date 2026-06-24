/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useApi } from '@/hooks/useApi'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useRegions } from '@/hooks/useRegions'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { Check, Copy } from '@/components/ui/icon'
import React, { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useCopyToClipboard } from 'usehooks-ts'

const DEFAULT_ORGANIZATION_DISPLAY_NAME = 'Default Organization'

const getOrganizationDisplayName = (name?: string) => {
  if (!name) return DEFAULT_ORGANIZATION_DISPLAY_NAME
  return name
}

const OrganizationSettings: React.FC = () => {
  const { axiosInstance } = useApi()
  const { refreshOrganizations } = useOrganizations()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const { getRegionName, sharedRegions: regions } = useRegions()

  const [organizationName, setOrganizationName] = useState('')
  const [renamingOrganization, setRenamingOrganization] = useState(false)
  const [copied, copyToClipboard] = useCopyToClipboard()
  const defaultRegionLabel = useMemo(() => {
    if (selectedOrganization?.defaultRegionId) {
      return getRegionName(selectedOrganization.defaultRegionId) ?? selectedOrganization.defaultRegionId
    }

    return regions[0]?.name ?? 'US'
  }, [getRegionName, regions, selectedOrganization?.defaultRegionId])

  useEffect(() => {
    setOrganizationName(getOrganizationDisplayName(selectedOrganization?.name))
  }, [selectedOrganization?.name])

  if (!selectedOrganization) {
    return null
  }

  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const trimmedOrganizationName = organizationName.trim()
  const currentOrganizationDisplayName = getOrganizationDisplayName(selectedOrganization.name)
  const organizationNameChanged =
    trimmedOrganizationName.length > 0 && trimmedOrganizationName !== currentOrganizationDisplayName

  const handleRenameOrganization = async () => {
    if (!isOwner || !organizationNameChanged) {
      return
    }

    setRenamingOrganization(true)
    try {
      await axiosInstance.patch(`/organizations/${selectedOrganization.id}/name`, { name: trimmedOrganizationName })
      toast.success('Organization renamed successfully')
      await refreshOrganizations(selectedOrganization.id)
    } catch (error) {
      handleApiError(error, 'Failed to rename organization')
    } finally {
      setRenamingOrganization(false)
    }
  }

  const inputClass =
    'w-full border border-border bg-card px-[14px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand disabled:opacity-60'

  return (
    <div className="px-[34px] pb-[26px] pt-[26px] lg:px-[40px]">
      <h2 className="mb-5 font-mono text-[13px] font-medium uppercase tracking-[3px] text-muted-foreground">
        Organization Settings
      </h2>

      <div className="border border-border">
        <div className="border-b border-border px-5 py-[15px] font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">
          Organization Details
        </div>

        {/* name */}
        <div className="grid items-center gap-4 border-b border-border px-5 py-5 sm:grid-cols-2">
          <div>
            <label htmlFor="organization-name" className="text-[13px] font-semibold">
              Organization Name
            </label>
            <p className="mt-1 text-[12px] text-muted-foreground">The public name of your organization.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              id="organization-name"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              readOnly={!isOwner}
              disabled={renamingOrganization}
              className={inputClass}
            />
            {isOwner && (
              <button
                type="button"
                onClick={handleRenameOrganization}
                disabled={!organizationNameChanged || renamingOrganization}
                className="flex-none bg-primary px-[18px] py-[11px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Save
              </button>
            )}
          </div>
        </div>

        {/* id */}
        <div className="grid items-center gap-4 border-b border-border px-5 py-5 sm:grid-cols-2">
          <div>
            <div className="text-[13px] font-semibold">Organization ID</div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              The unique identifier of your organization. Used in CLI and API calls.
            </p>
          </div>
          <div className="flex items-center border border-border bg-card pr-1">
            <input
              value={selectedOrganization.id}
              readOnly
              className="w-full bg-transparent px-[14px] py-[11px] font-mono text-[13px] text-foreground outline-none"
            />
            <button
              type="button"
              title="Copy"
              onClick={() => copyToClipboard(selectedOrganization.id).then(() => toast.success('Copied to clipboard'))}
              className="flex-none px-2 text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          </div>
        </div>

        {/* default region */}
        <div className="grid items-center gap-4 px-5 py-5 sm:grid-cols-2">
          <div>
            <div className="text-[13px] font-semibold">Default Region</div>
            <p className="mt-1 text-[12px] text-muted-foreground">Used automatically when creating boxes.</p>
          </div>
          <input value={defaultRegionLabel} readOnly className={`${inputClass} uppercase`} />
        </div>
      </div>
    </div>
  )
}

export default OrganizationSettings
