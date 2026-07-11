/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { BalanceOverviewCard } from '@/components/billing/BalanceOverviewCard'
import { BillingPaymentMethodSection } from '@/components/billing/BillingPaymentMethodSection'
import { BillingPaymentPanel } from '@/components/billing/BillingPaymentPanel'
import { QuotaPanel } from '@/components/billing/QuotaPanel'
import { UsageTrendCharts } from '@/components/billing/UsageTrendCharts'
import { SectionTitle } from '@/components/billing/ascii'
import { Calendar, RefreshCw } from '@/components/ui/icon'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBillingOverviewQuery } from '@/hooks/queries/useBillingOverviewQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { cn } from '@/lib/utils'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useMemo, useState, type ReactNode } from 'react'

const RANGE_OPTIONS = [
  { id: '1h', label: 'Last 1 hour', milliseconds: 60 * 60 * 1000 },
  { id: '24h', label: 'Last 24 hours', milliseconds: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', milliseconds: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', milliseconds: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All time', milliseconds: null },
] as const

type RangeId = (typeof RANGE_OPTIONS)[number]['id']
type BillingTab = 'usage' | 'billing'

function StatePanel({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'error' }) {
  return (
    <div
      className={cn(
        'border bg-card px-[22px] py-6 font-mono text-[13px]',
        tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-border text-muted-foreground',
      )}
    >
      {children}
    </div>
  )
}

function Billing() {
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const [activeTab, setActiveTab] = useState<BillingTab>('usage')
  const [rangeId, setRangeId] = useState<RangeId>('30d')
  const [rangeEnd, setRangeEnd] = useState(() => new Date())
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const selectedRange = RANGE_OPTIONS.find((range) => range.id === rangeId) ?? RANGE_OPTIONS[3]
  const range = useMemo(
    () => ({
      from:
        selectedRange.milliseconds == null ? new Date(0) : new Date(rangeEnd.getTime() - selectedRange.milliseconds),
      to: rangeEnd,
    }),
    [rangeEnd, selectedRange.milliseconds],
  )
  const overviewQuery = useBillingOverviewQuery({
    organizationId: selectedOrganization?.id ?? '',
    from: range.from,
    to: range.to,
    enabled: Boolean(selectedOrganization && isOwner),
  })

  const selectRange = (nextRangeId: RangeId) => {
    setRangeId(nextRangeId)
    setRangeEnd(new Date())
  }

  return (
    <PageLayout>
      <PageHeader size="full" className="pb-3">
        <PageTitle className="font-mono text-[24px] font-semibold normal-case text-foreground sm:text-[28px]">
          Billing
        </PageTitle>
      </PageHeader>

      <PageContent size="full" className="gap-6 font-mono">
        {!selectedOrganization ? (
          <StatePanel>Select an organization to view billing.</StatePanel>
        ) : !isOwner ? (
          <StatePanel>Only organization owners can view billing.</StatePanel>
        ) : (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as BillingTab)} className="gap-6">
            <TabsList className="h-9 w-fit justify-start rounded-none border border-border bg-background p-0">
              <TabsTrigger
                value="usage"
                className="h-full min-w-[78px] rounded-none border-r border-border px-4 font-mono text-[11px] data-[state=active]:bg-card data-[state=active]:text-foreground"
              >
                Usage
              </TabsTrigger>
              <TabsTrigger
                value="billing"
                className="h-full min-w-[78px] rounded-none px-4 font-mono text-[11px] data-[state=active]:bg-card data-[state=active]:text-foreground"
              >
                Billing
              </TabsTrigger>
            </TabsList>

            <TabsContent value="usage" className="mt-0">
              {overviewQuery.isLoading ? (
                <StatePanel>Loading billing data...</StatePanel>
              ) : overviewQuery.isError || !overviewQuery.data ? (
                <StatePanel tone="error">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>Billing data is unavailable.</span>
                    <button
                      type="button"
                      onClick={() => overviewQuery.refetch()}
                      className="inline-flex size-8 items-center justify-center border border-destructive/40 hover:bg-destructive/10"
                      title="Retry"
                    >
                      <RefreshCw className="size-4" />
                    </button>
                  </div>
                </StatePanel>
              ) : (
                <div className="flex flex-col gap-9">
                  <BalanceOverviewCard
                    totalBalanceCents={overviewQuery.data.wallet.totalBalanceCents}
                    freeBalanceCents={overviewQuery.data.wallet.freeBalanceCents}
                    paidBalanceCents={overviewQuery.data.wallet.paidBalanceCents}
                    spentThisMonthCents={overviewQuery.data.spentThisMonthCents}
                    freeExpiresAt={overviewQuery.data.wallet.freeExpiresAt}
                    paymentMethod={
                      <BillingPaymentMethodSection
                        organizationId={selectedOrganization.id}
                        onAddFunds={() => setActiveTab('billing')}
                      />
                    }
                  />

                  <QuotaPanel
                    cpu={selectedOrganization.maxCpuPerBox}
                    memory={selectedOrganization.maxMemoryPerBox}
                    disk={selectedOrganization.maxDiskPerBox}
                  />

                  <section>
                    <SectionTitle
                      title="Usage over time"
                      right={
                        <div className="flex items-center gap-1">
                          <label className="flex h-9 items-center border border-border bg-background px-3 text-[12px] text-foreground">
                            <Calendar className="mr-2 size-3.5 text-muted-foreground" />
                            <select
                              aria-label="Usage time range"
                              value={rangeId}
                              onChange={(event) => selectRange(event.target.value as RangeId)}
                              className="h-full appearance-none bg-transparent pr-5 font-mono outline-none"
                            >
                              {RANGE_OPTIONS.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={() => setRangeEnd(new Date())}
                            className="inline-flex size-9 items-center justify-center border border-border text-muted-foreground hover:text-foreground"
                            title="Refresh usage"
                          >
                            <RefreshCw className={cn('size-3.5', overviewQuery.isFetching && 'animate-spin')} />
                          </button>
                        </div>
                      }
                    />
                    <UsageTrendCharts usage={overviewQuery.data.usage} buckets={overviewQuery.data.usageBuckets} />
                  </section>
                </div>
              )}
            </TabsContent>

            <TabsContent value="billing" className="mt-0">
              <BillingPaymentPanel organizationId={selectedOrganization.id} />
            </TabsContent>
          </Tabs>
        )}
      </PageContent>
    </PageLayout>
  )
}

export default Billing
