/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useNavigate } from 'react-router-dom'
import { CiJobSetup } from '@/components/ci/CiJobSetup'
import { ConnectsPanel } from '@/components/ci/ConnectsPanel'
import { RunnersPanel } from '@/components/ci/RunnersPanel'
import { TabIcon } from '@/components/ui/TabIcon'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RoutePath } from '@/enums/RoutePath'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { usePageTitle } from '@/hooks/usePageTitle'

export default function CiPage({ tab }: { tab: 'runners' | 'connects' }) {
  usePageTitle(tab === 'connects' ? 'GitHub connections · CI' : 'Runners · CI')
  const navigate = useNavigate()
  const { selectedOrganization } = useSelectedOrganization()
  if (!selectedOrganization) return null
  return (
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <div className="resource-page-header">
        <h1 className="font-display text-page font-semibold text-foreground">CI</h1>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body leading-relaxed text-muted-foreground">
          <p>Run GitHub Actions on BoxLite.</p>
          <CiJobSetup key={selectedOrganization.id} label="How to run a job" />
        </div>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => navigate(value === 'connects' ? RoutePath.CI_CONNECTS : RoutePath.CI)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList
          variant="underline"
          aria-label="CI views"
          className="mb-4 w-full justify-start border-b border-border"
        >
          <TabsTrigger value="runners">
            <TabIcon name="boxes" />
            Runners
          </TabsTrigger>
          <TabsTrigger value="connects">
            <TabIcon name="github" />
            GitHub connections
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="runners"
          className="m-0 min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
        >
          <RunnersPanel key={selectedOrganization.id} />
        </TabsContent>
        <TabsContent
          value="connects"
          className="m-0 min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
        >
          <ConnectsPanel key={selectedOrganization.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
