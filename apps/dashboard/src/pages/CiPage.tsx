/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { TabIcon } from '@/components/ui/TabIcon'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConnectsPanel } from '@/components/ci/ConnectsPanel'
import { RunnersPanel } from '@/components/ci/RunnersPanel'
import { RoutePath } from '@/enums/RoutePath'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useNavigate } from 'react-router-dom'
import { usePageTitle } from '@/hooks/usePageTitle'

export default function CiPage({ tab }: { tab: 'runners' | 'connects' }) {
  usePageTitle(tab === 'connects' ? 'Connects' : 'Runners')
  const navigate = useNavigate()
  const { selectedOrganization } = useSelectedOrganization()
  if (!selectedOrganization) return null
  return (
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <Tabs
        value={tab}
        className="flex min-h-0 flex-1 flex-col gap-0"
        onValueChange={(value) => navigate(value === 'connects' ? RoutePath.CI_CONNECTS : RoutePath.CI)}
      >
        <div className="resource-page-header flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-page font-semibold text-foreground">
              {tab === 'runners' ? 'Runners' : 'Connects'}
            </h1>
            <p className="mt-2 text-body leading-relaxed text-muted-foreground">
              {tab === 'runners'
                ? 'Ephemeral Boxes running your GitHub Actions jobs.'
                : 'GitHub accounts connected to this organization.'}
            </p>
          </div>
          <TabsList variant="underline" aria-label="CI views" className="md:hidden">
            <TabsTrigger value="runners">
              <TabIcon name="boxes" />
              Runners
            </TabsTrigger>
            <TabsTrigger value="connects">
              <TabIcon name="github" />
              Connects
            </TabsTrigger>
          </TabsList>
        </div>
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
