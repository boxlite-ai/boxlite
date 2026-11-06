import type { AdminOrganizationOverviewPage } from '../src/models/admin-organization-overview-page'
import { AdminApi, AdminApiAxiosParamCreator, AdminApiFactory, AdminApiFp } from '../src/api/admin-api'
import type { RawAxiosRequestConfig } from 'axios'

// Every list response includes statistics, including registration-window reads.
export function boxCount(page: AdminOrganizationOverviewPage): number | undefined {
  return page.items[0]?.boxCount
}

// Old six-argument and extended eight-argument calls must compile on every generated surface.
export function requestOptions(admin: AdminApi) {
  const clients = [admin, AdminApiFactory(), AdminApiFp(), AdminApiAxiosParamCreator()]
  const options: RawAxiosRequestConfig = { headers: { Authorization: 'Bearer synthetic-type-fixture' }, timeout: 1000 }
  for (const client of clients) {
    client.adminListOrganizationsOverview(undefined, 'next', 20, undefined, undefined, options)
    client.adminListOrganizationsOverview(undefined, 'next', 20, undefined, undefined, 'all', undefined, options)
    client.adminListOrganizationsOverview(undefined, 'next', 20, undefined, undefined, undefined, 'org-id', options)
  }
}
