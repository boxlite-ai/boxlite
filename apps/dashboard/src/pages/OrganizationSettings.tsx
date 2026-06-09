/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { useApi } from '@/hooks/useApi'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useRegions } from '@/hooks/useRegions'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { CheckIcon, CopyIcon } from 'lucide-react'
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

  return (
    <PageLayout>
      <PageHeader>
        <PageTitle>Settings</PageTitle>
      </PageHeader>

      <PageContent>
        <Card>
          <CardHeader className="p-4">
            <CardTitle>Organization Details</CardTitle>
          </CardHeader>
          <CardContent className="border-t border-border">
            <Field className="grid sm:grid-cols-2 items-center">
              <FieldContent className="flex-1">
                <FieldLabel htmlFor="organization-name">Organization Name</FieldLabel>
                <FieldDescription>The public name of your organization.</FieldDescription>
              </FieldContent>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id="organization-name"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  readOnly={!isOwner}
                  disabled={renamingOrganization}
                  className="flex-1"
                />
                {isOwner && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleRenameOrganization}
                    disabled={!organizationNameChanged || renamingOrganization}
                  >
                    Save
                  </Button>
                )}
              </div>
            </Field>
          </CardContent>

          <CardContent className="border-t border-border">
            <Field className="grid sm:grid-cols-2 items-center">
              <FieldContent className="flex-1">
                <FieldLabel htmlFor="organization-id">Organization ID</FieldLabel>
                <FieldDescription>
                  The unique identifier of your organization.
                  <br />
                  Used in CLI and API calls.
                </FieldDescription>
              </FieldContent>
              <InputGroup className="pr-1 flex-1">
                <InputGroupInput id="organization-id" value={selectedOrganization.id} readOnly />
                <InputGroupButton
                  variant="ghost"
                  size="icon-xs"
                  onClick={() =>
                    copyToClipboard(selectedOrganization.id).then(() => toast.success('Copied to clipboard'))
                  }
                >
                  {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                </InputGroupButton>
              </InputGroup>
            </Field>
          </CardContent>
          <CardContent className="border-t border-border">
            <Field className="grid sm:grid-cols-2 items-center">
              <FieldContent className="flex-1">
                <FieldLabel htmlFor="organization-default-region">Default Region</FieldLabel>
                <FieldDescription>Used automatically when creating boxes.</FieldDescription>
              </FieldContent>
              <Input
                id="organization-default-region"
                value={defaultRegionLabel}
                readOnly
                className="flex-1 uppercase"
              />
            </Field>
          </CardContent>
        </Card>
      </PageContent>
    </PageLayout>
  )
}

export default OrganizationSettings
