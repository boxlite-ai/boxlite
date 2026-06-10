/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { TierComparisonTable, TierComparisonTableSkeleton } from '@/components/TierComparisonTable'
import { TierUpgradeCard } from '@/components/TierUpgradeCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RoutePath } from '@/enums/RoutePath'
import { useOwnerTierQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { useTiersQuery } from '@/hooks/queries/useTiersQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { RefreshCcw } from 'lucide-react'
import { ReactNode, useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { useNavigate } from 'react-router-dom'

export default function Limits() {
  const { user } = useAuth()
  const { selectedOrganization } = useSelectedOrganization()
  const organizationTierQuery = useOwnerTierQuery()
  const walletQuery = useOwnerWalletQuery()
  const tiersQuery = useTiersQuery()

  const organizationTier = organizationTierQuery.data
  const tiers = tiersQuery.data?.sort((a, b) => a.tier - b.tier)
  const wallet = walletQuery.data

  const config = useConfig()
  const navigate = useNavigate()

  useEffect(() => {
    if (selectedOrganization && !selectedOrganization.defaultRegionId) {
      navigate(RoutePath.SETTINGS)
    }
  }, [navigate, selectedOrganization])

  const isLoading = organizationTierQuery.isLoading || tiersQuery.isLoading || walletQuery.isLoading
  const isError = organizationTierQuery.isError || tiersQuery.isError || walletQuery.isError

  const handleRetry = () => {
    organizationTierQuery.refetch()
    tiersQuery.refetch()
    walletQuery.refetch()
  }

  return (
    <PageLayout>
      <PageHeader>
        <PageTitle>Limits</PageTitle>
      </PageHeader>

      <PageContent>
        {isError ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-center">Oops, something went wrong</CardTitle>
            </CardHeader>
            <CardContent className="flex justify-between items-center flex-col gap-3">
              <div>There was an error loading your limits.</div>
              <Button variant="outline" onClick={handleRetry}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader className="p-4">
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <CardTitle className="flex justify-between gap-x-4 gap-y-2 flex-row flex-wrap items-center">
                    <div className="flex items-center gap-2">
                      Current Usage{' '}
                      {organizationTier && (
                        <Badge variant="outline" className="font-mono uppercase">
                          Tier {organizationTier.tier}
                        </Badge>
                      )}
                    </div>
                  </CardTitle>
                </div>
                <CardDescription>
                  Limits help us mitigate misuse and manage infrastructure resources. <br /> Ensuring fair and stable
                  access to boxes and compute capacity across all users.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 flex flex-col">
                <RateLimits
                  title="Box Limits"
                  description="Resources limit per box."
                  className="border-t border-border"
                  rateLimits={[
                    { label: 'Compute', value: selectedOrganization?.maxCpuPerBox, unit: 'vCPU' },
                    { label: 'Memory', value: selectedOrganization?.maxMemoryPerBox, unit: 'GiB' },
                    { label: 'Storage', value: selectedOrganization?.maxDiskPerBox, unit: 'GiB' },
                  ]}
                />

                <RateLimits
                  title="Rate Limits"
                  description="How many requests you can make."
                  className="border-t border-border"
                  rateLimits={[
                    {
                      value: selectedOrganization?.authenticatedRateLimit || config?.rateLimit?.authenticated?.limit,
                      label: 'General Requests',
                      ttlSeconds:
                        selectedOrganization?.authenticatedRateLimitTtlSeconds ?? config?.rateLimit?.authenticated?.ttl,
                    },
                    {
                      value: selectedOrganization?.boxCreateRateLimit || config?.rateLimit?.boxCreate?.limit,
                      label: 'Box Creation',
                      ttlSeconds:
                        selectedOrganization?.boxCreateRateLimitTtlSeconds ?? config?.rateLimit?.boxCreate?.ttl,
                    },
                    {
                      value: selectedOrganization?.boxLifecycleRateLimit || config?.rateLimit?.boxLifecycle?.limit,
                      label: 'Box Lifecycle',
                      ttlSeconds:
                        selectedOrganization?.boxLifecycleRateLimitTtlSeconds ?? config?.rateLimit?.boxLifecycle?.ttl,
                    },
                  ]}
                />
              </CardContent>
            </Card>

            {config.billingApiUrl && selectedOrganization && (
              <>
                <TierUpgradeCard
                  organizationTier={organizationTier}
                  tiers={tiers || []}
                  organization={selectedOrganization}
                  requirementsState={{
                    emailVerified: !!user?.profile?.email_verified,
                    creditCardLinked: !!wallet?.creditCardConnected,
                  }}
                />

                <Card className="mb-10">
                  <CardHeader>
                    <CardTitle className="flex items-center mb-2">Limits</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {isLoading ? (
                      <TierComparisonTableSkeleton />
                    ) : (
                      <TierComparisonTable
                        className="border-l-0 border-r-0 rounded-none only:mb-4"
                        tiers={tiers || []}
                        currentTier={organizationTier}
                      />
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </>
        )}
      </PageContent>
    </PageLayout>
  )
}

interface LimitItem {
  value?: number | null
  unit?: string
  label: string
  ttlSeconds?: number | null
}

function RateLimits({
  rateLimits,
  className,
  title,
  description,
}: {
  rateLimits: LimitItem[]
  className?: string
  title: ReactNode
  description: ReactNode
}) {
  const isEmpty = rateLimits.every(({ value }) => !value)
  if (isEmpty) {
    return null
  }

  return (
    <div className={cn('p-4 border-t border-border flex flex-col gap-4', className)}>
      <div className="flex flex-col gap-1">
        <div className="text-foreground text-sm font-medium">{title}</div>
        <div className="text-muted-foreground text-sm">{description}</div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:gap-4 sm:grid-cols-3">
        {rateLimits.map(
          ({ label, value, unit, ttlSeconds }) =>
            value && <RateLimitItem key={label} label={label} value={value} unit={unit} ttlSeconds={ttlSeconds} />,
        )}
      </div>
    </div>
  )
}

function formatTtl(ttlSeconds?: number | null): string {
  if (!ttlSeconds) return ' / min'
  if (ttlSeconds % 60 === 0) return ` / ${ttlSeconds / 60}min`
  return ` / ${ttlSeconds}s`
}

function RateLimitItem({ label, value, unit, ttlSeconds }: LimitItem) {
  if (!value) {
    return null
  }

  return (
    <div className="flex flex-col">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-foreground text-sm font-medium">
        {value?.toLocaleString()}
        {unit ? ` ${unit}` : formatTtl(ttlSeconds)}
      </div>
    </div>
  )
}
