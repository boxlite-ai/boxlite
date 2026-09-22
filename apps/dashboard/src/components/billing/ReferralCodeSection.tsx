/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CopyButton } from '@/components/CopyButton'
import { Panel, SectionTitle } from '@/components/ascii'
import { Button } from '@/components/ui/button'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useQuery } from '@tanstack/react-query'
import { isAxiosError } from 'axios'

export function ReferralCodeSection() {
  const { selectedOrganization } = useSelectedOrganization()
  const { organizationsApi } = useApi()
  const organizationId = selectedOrganization?.id ?? ''
  const {
    data: code,
    isPending,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.organization.referralCode(organizationId),
    queryFn: async ({ signal }) => {
      const response = await organizationsApi.getOrganizationReferralCode(organizationId, { signal })
      return response.data.referralCode
    },
    enabled: !!organizationId,
    staleTime: Infinity,
    // An invitation must never retain the previous organization's code.
    placeholderData: undefined,
    retry: false,
  })

  if (!selectedOrganization) return null

  const errorStatus = isAxiosError(error?.cause) ? error.cause.response?.status : undefined
  let errorMessage = 'Could not load the invitation code.'
  if (errorStatus === 403) {
    errorMessage = 'Invitations are not available for this organization.'
  } else if (errorStatus === 429) {
    errorMessage = 'Too many requests. Please try again shortly.'
  }

  return (
    <section aria-label="Invitation code" className="mt-8">
      <SectionTitle title="Invitation code" />
      <Panel className="space-y-4 px-[22px] py-5">
        <p className="text-sm">
          Invitation code for <strong>{selectedOrganization.name}</strong>.
        </p>
        {isPending ? (
          <p role="status">Loading invitation code…</p>
        ) : isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <span>{errorMessage}</span>
            <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              {isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <code className="select-all break-all font-mono">{code}</code>
            {/* Reset copied feedback when switching organizations. */}
            <CopyButton key={organizationId} value={code} tooltipText="Copy invitation code" size="icon-xs" />
          </div>
        )}
      </Panel>
    </section>
  )
}
