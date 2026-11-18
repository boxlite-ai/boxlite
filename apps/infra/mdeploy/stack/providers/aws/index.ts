/*
 * The AWS answer to every module, as one bundle.
 *
 * The stack is written against `StackProviders` and names no cloud; this file
 * is where the cloud is chosen, once. It is also the only place the tagged
 * unions are narrowed: `Extract<…, { cloud: 'aws' }>` appears here rather than
 * at a dozen call sites, and each narrowing says which module was handed the
 * wrong cloud rather than failing on a field that does not exist.
 *
 * Nothing here builds a resource. Every entry is a function from the modules it
 * depends on to a provider, so the bundle exists before the first resource does
 * and the stack decides the order.
 */

import type { StackProviders } from '../../index.ts'
import type { Network, NetworkBinding, Placement } from '../../network.ts'
import type { WorkloadHost } from '../../cluster.ts'
import { awsImages } from '../../image.ts'
import { awsAlarmProvider } from './alarms.ts'
import { awsApiProvider } from './api.ts'
import { awsCacheProvider } from './cache.ts'
import { awsClickHouseProvider } from './clickhouse.ts'
import { awsClusterProvider } from './cluster.ts'
import { awsCollectorProvider } from './collector.ts'
import { awsDatabaseProvider } from './database.ts'
import { awsEdgeProvider } from './edge.ts'
import { awsMailProvider } from './mail.ts'
import { awsNetworkProvider } from './network.ts'
import { awsRunnerProvider } from './runners.ts'
import { awsStorageProvider } from './storage.ts'
import { awsRegistryProxyProvider } from './registry-proxy.ts'
import { awsRegistryCredentialStoreProvider } from './registry-credentials.ts'

const onAws = <T extends { cloud: string }>(value: T, what: string): Extract<T, { cloud: 'aws' }> => {
  if (value.cloud !== 'aws') throw new Error(`The AWS stack was handed ${value.cloud} ${what}`)
  return value as Extract<T, { cloud: 'aws' }>
}

const binding = (network: Network): Extract<NetworkBinding, { cloud: 'aws' }> => onAws(network.binding, 'network')
const host = (value: WorkloadHost): Extract<WorkloadHost, { cloud: 'aws' }> => onAws(value, 'host')
const placement = (value: Placement): Extract<Placement, { cloud: 'aws' }> => onAws(value, 'placement')

export const awsStackProviders = ({
  stage,
  region,
  accountId,
  domain,
  dashboardDomain = null,
  stateBucket,
  artifactsBucket,
  volumePrefix = 'boxlite-volume',
  zoneId,
  managedClickHouse,
  otelOpenapiEnabled = false,
  existingDatabasePasswordRef,
  existingCachePasswordRef,
  existingVolumeRoleName,
}: {
  stage: string
  region: string
  accountId: string
  /** The stage's own domain. The API's hostname sits under it. */
  domain: string
  /** Where the dashboard's CDN answers, or null for the stage domain itself. */
  dashboardDomain?: string | null
  /** Where a build-mode runner binary is staged, for the runner's read grant. */
  artifactsBucket: string
  stateBucket: string
  volumePrefix?: string
  zoneId: string
  /**
   * The endpoint and its two secrets for a stage that runs no ClickHouse of its
   * own. Absent rather than empty: a stage with neither has nothing to record,
   * and one with `mode: managed` and no endpoint is refused by the provider.
   */
  managedClickHouse: { url: string; writerSecretArn: string; readerSecretArn: string } | null
  otelOpenapiEnabled?: boolean
  existingDatabasePasswordRef?: string
  existingCachePasswordRef?: string
  existingVolumeRoleName?: string
}): StackProviders => {
  return {
    // mbuild keys the registry by stage, so the addresses come from there
    // rather than from anything this file composes.
    images: awsImages({ stage, region }),
    network: awsNetworkProvider({ region }),
    storage: awsStorageProvider({ accountId, existingVolumeRoleName }),
    cluster: ({ network }) => awsClusterProvider({ network }),
    database: ({ network }) =>
      awsDatabaseProvider({ network: binding(network), existingPasswordRef: existingDatabasePasswordRef }),
    cache: ({ network }) =>
      awsCacheProvider({ network: binding(network), existingPasswordRef: existingCachePasswordRef }),
    clickhouse: ({ network }) =>
      awsClickHouseProvider({ network: binding(network), region, managed: managedClickHouse, otelOpenapiEnabled }),
    mail: awsMailProvider({ region, zoneId }),
    collector: ({ host: where, clickhouse, dependsOn }) =>
      awsCollectorProvider({ host: host(where), clickhouse, dependsOn }),
    // The network is ignored here: a security group already says who may reach
    // the API, and repeating it as an identity would be a second answer.
    api: ({ dependencies }) => awsApiProvider({ dependencies, zoneId, domain, dashboardDomain }),
    edge: ({ host: where, network, dependsOn }) =>
      awsEdgeProvider({ host: host(where), placement: placement(network.placementFor('proxy')), zoneId, dependsOn }),
    servesUserDomain: () => true,
    resizeRunnerDisks: () => true,
    registryProxy: ({ host: where, network, registryCredentials, dependsOn }) =>
      awsRegistryProxyProvider({
        host: host(where),
        placement: placement(network.placementFor('registry-proxy')),
        runnerPlacement: placement(network.placementFor('runner')),
        domain,
        zoneId,
        registryCredentials,
        dependsOn,
      }),
    registryCredentials: awsRegistryCredentialStoreProvider({ accountId, region }),
    // 64 alphanumeric characters: the value travels through a systemd
    // EnvironmentFile and a JSON payload, and punctuation would drag quoting
    // rules into both.
    mintRunnerToken: (name) => new random.RandomPassword(name, { length: 64, special: false }).result,
    // No host: a runner is a machine, so it takes its placement straight from
    // the network. That placement is `egress-only-public`, and the provider
    // refuses anything else rather than creating a host that cannot pull.
    runners: ({ network, adminApiKey, regionId, dependsOn }) =>
      awsRunnerProvider({
        stateBucket,
        placement: placement(network.placementFor('runner')),
        region,
        accountId,
        volumePrefix,
        artifactsBucket,
        adminApiKey,
        regionId,
        dependsOn,
      }),
    alarms: ({ subjects }) => awsAlarmProvider({ subjects }),
  }
}
