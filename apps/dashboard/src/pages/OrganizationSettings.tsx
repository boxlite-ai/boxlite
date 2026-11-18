/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TabIcon } from '@/components/ui/TabIcon'
import { AsciiButton } from '@/components/ascii'
import { ResourceSectionHeading } from '@/components/ResourceLayout'
import { useApi } from '@/hooks/useApi'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { Check, Copy } from '@/components/ui/icon'
import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useCopyToClipboard } from 'usehooks-ts'
import { useSearchParams } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import OrganizationMembers from './OrganizationMembers'
import { Navigate } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'
import { usePageTitle } from '@/hooks/usePageTitle'

const DEFAULT_ORGANIZATION_DISPLAY_NAME = 'Default Organization'

const getOrganizationDisplayName = (name?: string) => {
  if (!name) return DEFAULT_ORGANIZATION_DISPLAY_NAME
  return name
}

const OrganizationGeneral: React.FC = () => {
  const { axiosInstance } = useApi()
  const { refreshOrganizations } = useOrganizations()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()

  const [organizationName, setOrganizationName] = useState('')
  const [renamingOrganization, setRenamingOrganization] = useState(false)
  const [copied, copyToClipboard] = useCopyToClipboard()

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
    'w-full border border-border bg-card px-[14px] py-[11px] font-sans text-body text-foreground outline-none focus:border-brand disabled:opacity-60'

  return (
    <div className="border border-border">
      <ResourceSectionHeading title="Organization details" className="mb-0 border-b border-border px-5 py-4" />

      {/* name */}
      <div className="grid items-center gap-4 border-b border-border px-5 py-5 sm:grid-cols-2">
        <div>
          <label htmlFor="organization-name" className="text-body font-semibold">
            Organization name
          </label>
          <p className="mt-1 text-meta text-muted-foreground">The public name of your organization.</p>
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
            <AsciiButton
              variant="primary"
              type="button"
              onClick={handleRenameOrganization}
              disabled={!organizationNameChanged || renamingOrganization}
            >
              Save
            </AsciiButton>
          )}
        </div>
      </div>

      {/* id */}
      <div className="grid items-center gap-4 px-5 py-5 sm:grid-cols-2">
        <div>
          <div className="text-body font-semibold">Organization ID</div>
          <p className="mt-1 text-meta leading-relaxed text-muted-foreground">
            The unique identifier of your organization. Used in CLI and API calls.
          </p>
        </div>
        <div className="flex items-center border border-border bg-card pr-1">
          <input
            value={selectedOrganization.id}
            readOnly
            className="w-full bg-transparent px-[14px] py-[11px] font-mono text-body text-foreground outline-none"
          />
          <button
            type="button"
            title="Copy"
            onClick={async () => {
              if (await copyToClipboard(selectedOrganization.id)) toast.success('Copied to clipboard')
              else toast.error('Could not copy to clipboard')
            }}
            className="flex-none px-2 text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}

const OrganizationSettings: React.FC = () => {
  usePageTitle('Organization')
  const { selectedOrganization } = useSelectedOrganization()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'member' ? 'member' : 'general'

  if (searchParams.get('tab') === 'ci') return <Navigate to={RoutePath.CI_CONNECTS} replace />

  if (!selectedOrganization) return null

  return (
    <div className="page-container py-6">
      <h1 className="resource-title">Organization</h1>
      <p className="mt-2 text-body leading-relaxed text-muted-foreground">
        Manage settings and members for <span>{getOrganizationDisplayName(selectedOrganization.name)}</span>.
      </p>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams)
          if (value === 'member') next.set('tab', value)
          else next.delete('tab')
          setSearchParams(next)
        }}
        className="mt-5 gap-0"
      >
        <TabsList variant="underline" aria-label="Organization settings">
          <TabsTrigger value="general">
            <TabIcon name="settings" />
            General
          </TabsTrigger>
          <TabsTrigger value="member">
            <TabIcon name="members" />
            Members
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="pt-6">
          <OrganizationGeneral key={selectedOrganization.id} />
        </TabsContent>
        <TabsContent value="member" className="pt-6">
          <OrganizationMembers key={selectedOrganization.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default OrganizationSettings
