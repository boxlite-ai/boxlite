import type { AdminOrganizationOverviewPage } from '../src/models/admin-organization-overview-page'

// Every list response includes statistics, including registration-window reads.
export function boxCount(page: AdminOrganizationOverviewPage): number | undefined {
  return page.items[0]?.boxCount
}
