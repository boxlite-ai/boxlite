/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useQuery } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { Link } from 'react-router-dom'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { RoutePath } from '@/enums/RoutePath'
import { Button } from '@/components/ui/button'
import { CiFirstJobGuide } from './CiFirstJobGuide'

export function CiJobSetup({ label, primary }: { label?: string; primary?: boolean }) {
  return <CiFirstJobGuide label={label} primary={primary} context={() => <ConnectionSummary />} />
}

function ConnectionSummary() {
  const api = useApi()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const owner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const organization = selectedOrganization!.id
  const settings = useQuery({
    queryKey: ['ci-settings', organization],
    queryFn: () => api.getCiSettings(organization),
    enabled: owner,
    retry: false,
  })
  if (!owner)
    return (
      <p className="text-muted-foreground">
        Ask an account owner to confirm that GitHub is connected to this BoxLite organization.
      </p>
    )
  if (settings.isPending)
    return (
      <p role="status" className="text-muted-foreground">
        Checking GitHub connection…
      </p>
    )
  if (settings.isError)
    return (
      <div className="space-y-2">
        <p role="alert">Couldn’t check your GitHub connection.</p>
        <Button variant="outline" size="sm" onClick={() => void settings.refetch()} disabled={settings.isFetching}>
          Retry connections
        </Button>
      </div>
    )
  if (!settings.data.available) return <p>Hosted CI is not enabled on this deployment.</p>
  if (!settings.data.connections.length)
    return (
      <p>
        <Link className="resource-guide-link" to={RoutePath.CI_CONNECTS} target="_blank" rel="noopener noreferrer">
          Set up GitHub
        </Link>{' '}
        to run workflows on BoxLite.
      </p>
    )
  return (
    <p className="text-muted-foreground">
      GitHub connected · <span className="text-foreground">{selectedOrganization!.name}</span>
    </p>
  )
}
