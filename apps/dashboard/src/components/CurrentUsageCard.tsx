/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { UsageOverview, UsageOverviewSkeleton } from '@/components/UsageOverview'
import { useOrganizationUsageOverviewQuery } from '@/hooks/queries/useOrganizationUsageOverviewQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { AlertCircle } from '@/components/ui/icon'
import { keepPreviousData } from '@tanstack/react-query'

/**
 * The organization's live consumption against its quota.
 *
 * Upstream's version carries a region selector, sandbox-class tabs and per-scope
 * alerts because its quotas are per (region, class). BoxLite has one org-wide
 * quota row, so there is nothing to scope by and the card is just the overview.
 */
export function CurrentUsageCard({ organizationTier }: { organizationTier?: { tier?: number | null } | null }) {
  const { selectedOrganization } = useSelectedOrganization()

  const usageOverviewQuery = useOrganizationUsageOverviewQuery(
    { organizationId: selectedOrganization?.id ?? '' },
    { placeholderData: keepPreviousData },
  )
  const usageOverview = usageOverviewQuery.data

  return (
    <Card>
      <CardHeader className="p-4 space-y-0">
        <CardTitle className="flex items-center gap-2 mb-2">
          Current Usage
          {organizationTier?.tier != null && (
            <Badge variant="outline" className="font-mono uppercase">
              Tier {organizationTier.tier}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Limits help us mitigate misuse and manage infrastructure resources, ensuring fair and stable access to boxes
          and compute capacity across all users.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {usageOverview ? (
          <UsageOverview usageOverview={usageOverview} />
        ) : usageOverviewQuery.isError ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertCircle className="w-4 h-4" />
            Current usage is unavailable right now.
          </div>
        ) : (
          <UsageOverviewSkeleton />
        )}
      </CardContent>
    </Card>
  )
}
