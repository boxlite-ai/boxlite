import { Organization } from '@boxlite-ai/api-client'

export function resolveSelectedOrganizationId(organizations: Organization[], storedOrganizationId: string | null) {
  if (storedOrganizationId && organizations.some((org) => org.id === storedOrganizationId)) {
    return storedOrganizationId
  }

  return organizations.find((org) => org.isDefaultForAuthenticatedUser)?.id ?? organizations[0]?.id ?? null
}
