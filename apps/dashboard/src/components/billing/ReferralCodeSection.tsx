/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, SectionTitle } from '@/components/ascii'
import { Button } from '@/components/ui/button'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useQuery } from '@tanstack/react-query'

export function ReferralCodeSection() {
  const { selectedOrganization } = useSelectedOrganization()
  const { organizationsApi } = useApi()
  const organizationId = selectedOrganization?.id ?? ''
  const {
    data: code,
    isPending,
    isFetching,
    isError,
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
            <span>Could not load the invitation code.</span>
            <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              {isFetching ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        ) : (
          <code className="select-all break-all font-mono">{code}</code>
        )}
      </Panel>
    </section>
  )
}
