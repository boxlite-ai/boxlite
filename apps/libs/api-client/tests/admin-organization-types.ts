import type { AdminListOrganizationsOverview200Response } from '../src/models/admin-list-organizations-overview200-response'

// The generated response must let consumers narrow a full record without
// pretending statistics exist on a registration-only response.
export function boxCount(page: AdminListOrganizationsOverview200Response): number | undefined {
  const organization = page.items[0]
  if (organization && 'boxCount' in organization) return organization.boxCount
  return undefined
}
