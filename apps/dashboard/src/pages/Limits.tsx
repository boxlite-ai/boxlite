/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote, SectionTitle } from '@/components/ascii'
import { CycleOverview } from '@/components/billing/CycleOverview'
import { EnterpriseRow, PlanCards, PlanCardsSkeleton } from '@/components/billing/PlanCards'
import { Button } from '@/components/ui/button'
import { useOwnerTierQuery, useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { useTiersQuery } from '@/hooks/queries/useTiersQuery'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { cn } from '@/lib/utils'
import { RefreshCcw } from '@/components/ui/icon'
import { ReactNode } from 'react'
import { useAuth } from 'react-oidc-context'

export default function Limits() {
  const { user } = useAuth()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organizationTierQuery = useOwnerTierQuery()
  const walletQuery = useOwnerWalletQuery()
  const tiersQuery = useTiersQuery()

  const organizationTier = organizationTierQuery.data
  const tiers = tiersQuery.data?.sort((a, b) => a.tier - b.tier)
  const wallet = walletQuery.data

  const config = useConfig()
  // useTiersQuery is gated only on config.billingApiUrl, so plan switching is gated here.
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  const isLoading = organizationTierQuery.isLoading || tiersQuery.isLoading || walletQuery.isLoading
  const isError = organizationTierQuery.isError || tiersQuery.isError || walletQuery.isError

  const handleRetry = () => {
    organizationTierQuery.refetch()
    tiersQuery.refetch()
    walletQuery.refetch()
  }

  return (
    <div className="flex flex-col gap-8">
      {isError ? (
        <Panel className="flex flex-col items-center gap-3 px-[22px] py-10">
          <span className="font-mono text-[13px] text-foreground">Oops, something went wrong</span>
          <span className="font-mono text-[11px] text-muted-foreground">There was an error loading your limits.</span>
          <Button variant="outline" onClick={handleRetry} className="mt-1 font-mono text-[12px]">
            <RefreshCcw className="mr-2 size-4" />
            Retry
          </Button>
        </Panel>
      ) : (
        <div className="flex flex-col gap-8">
          {config.billingApiUrl && isOwner && wallet && (
            <section>
              <SectionTitle title="Active Plan" />
              <CycleOverview
                wallet={wallet}
                organizationTier={organizationTier}
                currentTier={tiers?.find((tier) => tier.tier === organizationTier?.tier)}
              />
            </section>
          )}

          {config.billingApiUrl && isOwner && selectedOrganization && (
            <section>
              <SectionTitle title="All Plans" count={tiers?.length ? `${tiers.length} tiers` : undefined} />
              {isLoading ? (
                <PlanCardsSkeleton count={4} />
              ) : (
                <PlanCards
                  tiers={tiers || []}
                  organizationTier={organizationTier}
                  organizationId={selectedOrganization.id}
                  requirementsState={{
                    emailVerified: !!user?.profile?.email_verified,
                    creditCardLinked: !!wallet?.creditCardConnected,
                  }}
                />
              )}
            </section>
          )}

          {/* Contact-sales stays outside the owner gate: any member could reach it
              from the old /dashboard/limits page. */}
          <section>
            <SectionTitle title="Enterprise" />
            <EnterpriseRow />
          </section>

          <section>
            <SectionTitle title="Resource Ceilings" count="per-organization" />
            <Panel>
              <RateLimits
                title="Box Limits"
                description="Resources limit per box."
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
                    ttlSeconds: selectedOrganization?.boxCreateRateLimitTtlSeconds ?? config?.rateLimit?.boxCreate?.ttl,
                  },
                  {
                    value: selectedOrganization?.boxLifecycleRateLimit || config?.rateLimit?.boxLifecycle?.limit,
                    label: 'Box Lifecycle',
                    ttlSeconds:
                      selectedOrganization?.boxLifecycleRateLimitTtlSeconds ?? config?.rateLimit?.boxLifecycle?.ttl,
                  },
                ]}
              />
            </Panel>
            <PanelNote>
              Limits mitigate misuse and keep box and compute capacity fairly available across all users.
            </PanelNote>
          </section>
        </div>
      )}
    </div>
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
    <div className={cn('flex flex-col gap-4 px-[22px] py-5', className)}>
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[11px] uppercase tracking-[1.5px] text-foreground">{title}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{description}</div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-4">
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
    <div className="flex flex-col gap-1">
      <div className="font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">{label}</div>
      <div className="font-mono text-[18px] font-semibold leading-none tabular-nums text-foreground">
        {value?.toLocaleString()}
        <span className="ml-1 text-[10px] font-normal uppercase tracking-[0.5px] text-muted-foreground">
          {unit ? unit : formatTtl(ttlSeconds)}
        </span>
      </div>
    </div>
  )
}
