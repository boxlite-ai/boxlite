/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConnectsPanel } from '@/components/ci/ConnectsPanel'
import { RunnersPanel } from '@/components/ci/RunnersPanel'
import { RoutePath } from '@/enums/RoutePath'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useNavigate } from 'react-router-dom'

export default function CiPage({ tab }: { tab: 'runners' | 'connects' }) {
  const navigate = useNavigate()
  const { selectedOrganization } = useSelectedOrganization()
  if (!selectedOrganization) return null
  return (
    <div className="page-container flex h-[calc(100svh-60px)] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-3 lg:mb-[22px]">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">CI</h1>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            {tab === 'runners'
              ? 'Ephemeral Boxes running your GitHub Actions jobs.'
              : 'GitHub accounts connected to this organization.'}
          </p>
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) => navigate(value === 'connects' ? RoutePath.CI_CONNECTS : RoutePath.CI)}
        >
          <TabsList variant="segmented" aria-label="CI views">
            <TabsTrigger value="runners">Runners</TabsTrigger>
            <TabsTrigger value="connects">Connects</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {tab === 'runners' ? (
        <RunnersPanel key={selectedOrganization.id} />
      ) : (
        <ConnectsPanel key={selectedOrganization.id} />
      )}
    </div>
  )
}
