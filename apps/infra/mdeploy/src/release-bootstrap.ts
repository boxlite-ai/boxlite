// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import type { JobVpcAccess, ReleaseLookup, ReleaseSettings } from './release-iam.ts'

type PrivateInstance = {
  name?: string
  connectionName?: string
  state?: string
  ipAddresses?: { type?: string }[]
  settings?: {
    userLabels?: Record<string, string>
    ipConfiguration?: {
      ipv4Enabled?: boolean
      privateNetwork?: string
      enablePrivatePathForGoogleCloudServices?: boolean
    }
  }
}

function computePath(url: string | undefined) {
  return url?.replace(/^https:\/\/(?:www\.googleapis\.com|compute\.googleapis\.com)\/compute\/v1\//, '')
}

export async function verifyInitialReleaseDatabase(
  settings: ReleaseSettings,
  vpc: JobVpcAccess | undefined,
  lookup: ReleaseLookup,
) {
  const { project, region, instance, initialProvisioning } = settings
  if (!initialProvisioning) throw new Error('First provisioning requires a protected bootstrap declaration')
  const subnetPath = `projects/${project}/regions/${region}/subnetworks/${initialProvisioning.subnetwork}`
  const subnet = computePath(vpc?.networkInterfaces?.[0]?.subnetwork)
  if (
    vpc?.networkInterfaces?.length !== 1 ||
    (vpc.egress !== 'PRIVATE_RANGES_ONLY' && vpc.egress !== 'ALL_TRAFFIC') ||
    (subnet !== subnetPath && subnet !== initialProvisioning.subnetwork)
  ) {
    throw new Error('Initial migration Job must use the declared private VPC subnet')
  }
  const [database, network] = await Promise.all([
    lookup<PrivateInstance>({
      url: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${project}/instances/${instance}`,
    }),
    lookup<{ network?: string }>({ url: `https://compute.googleapis.com/compute/v1/${subnetPath}` }),
  ])
  const privateNetwork = computePath(database.settings?.ipConfiguration?.privateNetwork)
  const networkScope = `projects/${project}/global/networks/`
  if (
    database.name !== instance ||
    database.connectionName !== `${project}:${region}:${instance}` ||
    database.state !== 'RUNNABLE' ||
    database.settings?.userLabels?.boxlite_release_bootstrap !== initialProvisioning.receipt ||
    database.settings.ipConfiguration?.ipv4Enabled !== false ||
    database.settings.ipConfiguration.enablePrivatePathForGoogleCloudServices !== true ||
    !database.ipAddresses?.some(({ type }) => type === 'PRIVATE') ||
    database.ipAddresses.some(({ type }) => type === 'PRIMARY') ||
    !privateNetwork?.startsWith(networkScope) ||
    privateNetwork !== computePath(network.network)
  ) {
    throw new Error('Initial release requires the recorded bootstrap receipt and private database network')
  }
  return initialProvisioning
}
