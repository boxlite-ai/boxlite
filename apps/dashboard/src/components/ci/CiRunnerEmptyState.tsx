/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useQuery } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { Link } from 'react-router-dom'
import { ResourceEmptyState } from '@/components/ResourceLayout'
import { Container, Github } from '@/components/ui/icon'
import { Button } from '@/components/ui/button'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { RoutePath } from '@/enums/RoutePath'
import { CiJobSetup } from './CiJobSetup'

/** Runner absence and connection readiness are independent facts. */
export function CiRunnerEmptyState() {
  const api = useApi()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organization = selectedOrganization!.id
  const role = authenticatedUserOrganizationMember?.role
  const owner = role === OrganizationUserRoleEnum.OWNER
  const settings = useQuery({
    queryKey: ['ci-settings', organization],
    queryFn: () => api.getCiSettings(organization),
    enabled: owner,
    retry: false,
  })
  if (!role || (owner && settings.isPending)) {
    return (
      <ResourceEmptyState
        icon={<Github />}
        role="status"
        title={role ? 'Checking GitHub connections…' : 'Checking access to GitHub connections…'}
      />
    )
  }
  if (!owner) {
    return (
      <ResourceEmptyState
        icon={<Github />}
        title="Ask an account owner to confirm access"
        description="An account owner can check which repositories are authorized to run jobs."
      />
    )
  }
  if (settings.isError) {
    return (
      <ResourceEmptyState
        icon={<Github />}
        role="alert"
        title="Connection status could not be confirmed"
        description="We couldn’t check your GitHub connections. Try again."
      >
        <Button disabled={settings.isFetching} onClick={() => void settings.refetch()}>
          {settings.isFetching ? 'Checking connections…' : 'Retry connections'}
        </Button>
      </ResourceEmptyState>
    )
  }
  if (!settings.data?.available) {
    return (
      <ResourceEmptyState
        icon={<Container />}
        title="Hosted CI is unavailable"
        description="Contact your administrator to enable Hosted CI on this deployment."
      />
    )
  }
  if (!settings.data.connections.length) {
    return (
      <ResourceEmptyState
        icon={<Github />}
        title="Connect GitHub to get started"
        description="Authorize your repositories to run GitHub Actions jobs on BoxLite."
      >
        <Button asChild>
          <Link to={RoutePath.CI_CONNECTS} target="_blank" rel="noopener noreferrer">
            Set up GitHub
          </Link>
        </Button>
      </ResourceEmptyState>
    )
  }
  return (
    <ResourceEmptyState
      icon={<Container />}
      title="No active runners"
      description="Runners appear when eligible GitHub Actions jobs start. Open the guide to configure a workflow."
    >
      <CiJobSetup label="Set up a job" primary />
    </ResourceEmptyState>
  )
}
