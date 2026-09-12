/*
 * The GCP answer to every module, as one bundle.
 *
 * The mirror of `../aws/index.ts`, and deliberately the same shape: the stack
 * is written against `StackProviders` and names no cloud, so choosing GCP is
 * choosing this file instead of that one. It is also the only place the tagged
 * unions are narrowed to `{ cloud: 'gcp' }`, so a module handed an AWS network
 * says so by name rather than failing on a field that is not there.
 *
 * Two asymmetries are real and are not hidden, and both come from the same
 * fact: Google authorises by identity where AWS authorises by position. Every
 * Cloud Run service here has to be told which accounts may invoke it, because
 * there is no security group to say it — so the API is handed the proxy's and
 * the runner's identities, and the collector is handed all three. On AWS
 * nothing is passed, because the network already arranged it.
 *
 * Applied against a real project: the `dev2` stage in `asia-southeast1`.
 */

import type { StackProviders } from '../../index.ts'
import type { Network, NetworkBinding, Placement } from '../../network.ts'
import { gcpImages } from '../../image.ts'
import { gcpAlarmProvider } from './alarms.ts'
import { gcpApiProvider } from './api.ts'
import { gcpCacheProvider } from './cache.ts'
import { CLICKHOUSE_CALLERS, gcpClickHouseProvider } from './clickhouse.ts'
import { gcpClusterProvider } from './cluster.ts'
import { gcpCollectorProvider } from './collector.ts'
import { gcpDatabaseProvider } from './database.ts'
import { gcpEdgeProvider } from './edge.ts'
import { gcpMailProvider } from './mail.ts'
import { gcpNetworkProvider } from './network.ts'
import { gcpRunnerProvider } from './runners.ts'
import { gcpStorageProvider } from './storage.ts'

const onGcp = <T extends { cloud: string }>(value: T, what: string): Extract<T, { cloud: 'gcp' }> => {
  if (value.cloud !== 'gcp') throw new Error(`The GCP stack was handed ${value.cloud} ${what}`)
  return value as Extract<T, { cloud: 'gcp' }>
}

const binding = (network: Network): Extract<NetworkBinding, { cloud: 'gcp' }> => onGcp(network.binding, 'network')
const placement = (network: Network, role: Parameters<Network['placementFor']>[0]): Extract<Placement, { cloud: 'gcp' }> =>
  onGcp(network.placementFor(role), 'placement')

/**
 * A zone in the stage's region: the one declared, or the region's first.
 *
 * An instance is zonal even where a subnet is not, so the two resources that
 * are machines — ClickHouse and the runners — need one. The default is derived
 * because "the first one" is what a stage with nothing to say about placement
 * means, and the override exists because that default can simply be unavailable:
 * a machine family is stocked per zone, and `asia-southeast1-a` refuses an N4
 * with `stockout` while `-b` creates one. A derived-only zone makes that a
 * deploy nothing can fix without editing this file.
 *
 * Exported because the roll asks the same question: `runner-update.ts` has to
 * list and reach the hosts a deploy created, and a second spelling of this
 * default is how the two come to disagree about where a fleet lives.
 */
export const zoneIn = (region: string, declared: string | null): string => declared ?? `${region}-a`

export const gcpStackProviders = ({
  stage,
  region,
  project,
  appShort,
  zone: declaredZone = null,
  domain,
  zoneId,
  relayHost = null,
  managedClickHouse = null,
  notificationChannels = [],
}: {
  stage: string
  region: string
  project: string
  /**
   * The app abbreviated, which is what every service account below is named
   * from. `mstage.env.json` declares it and `naming` holds it to the 30
   * characters a GCP service account id takes.
   */
  appShort: string
  /** The zone machines are created in, or null for the region's first. */
  zone?: string | null
  /** The hostname the dashboard and the SDKs reach the control plane on. */
  domain: string
  /** The Cloudflare zone every public record is written into. */
  zoneId: string
  /** The SMTP relay a GCP stage sends through. Google provides none. */
  relayHost?: string | null
  managedClickHouse?: { url: string; writerSecretArn: string; readerSecretArn: string } | null
  notificationChannels?: string[]
}): StackProviders => {
  const zone = zoneIn(region, declaredZone)

  return {
    images: gcpImages({ stage, region, project }),
    network: gcpNetworkProvider({ project, region, appShort }),
    storage: gcpStorageProvider({ project, region, appShort }),
    // Builds nothing: Cloud Run has no cluster. It still carries the network's
    // rules, which every workload waits on.
    cluster: ({ network }) => gcpClusterProvider({ region, network }),
    database: ({ network }) =>
      gcpDatabaseProvider({
        network: binding(network),
        project,
        region,
        clientAccount: placement(network, 'api').serviceAccount,
        dependsOn: network.ready,
      }),
    cache: ({ network }) =>
      gcpCacheProvider({
        network: binding(network),
        project,
        region,
        clientAccount: placement(network, 'api').serviceAccount,
        dependsOn: network.ready,
      }),
    clickhouse: ({ network }) =>
      gcpClickHouseProvider({
        network: binding(network),
        project,
        zone,
        appShort,
        // The collector writes and the API reads; both carry an account, and
        // the firewall admits those two and nothing else. The roles come from
        // the module that owns the rule, so this cannot hand over one identity
        // while that comment claims two — which is exactly what it used to do.
        callers: CLICKHOUSE_CALLERS.map((role) => placement(network, role).serviceAccount),
        managed: managedClickHouse,
        dependsOn: network.ready,
      }),
    mail: gcpMailProvider({ relayHost }),
    collector: ({ network, clickhouse, dependsOn }) =>
      gcpCollectorProvider({
        project,
        region,
        placement: placement(network, 'otel-collector'),
        clickhouse,
        // Everything that ships telemetry, named. There is no security group
        // to say it for us.
        callers: [
          placement(network, 'api').serviceAccount,
          placement(network, 'proxy').serviceAccount,
          placement(network, 'runner').serviceAccount,
        ],
        dependsOn,
      }),
    api: ({ dependencies, network }) =>
      gcpApiProvider({
        dependencies,
        project,
        region,
        domain,
        // The proxy resolves a box through it; a runner registers itself with
        // it. Cloud Run admits named invokers and nobody else.
        callers: [placement(network, 'proxy').serviceAccount, placement(network, 'runner').serviceAccount],
        zoneId,
        // The network itself and the runner's identity, for the internal
        // balancer and for the rule that keeps a runner off the public one. A
        // placement carries neither; see `api.ts`.
        network: binding(network).network,
        runnerAccount: placement(network, 'runner').serviceAccount,
      }),
    // Not a Cloud Run service: Cloud Run cannot be a backend of the balancer
    // this needs, so the proxy runs on VMs. See `edge.ts`.
    edge: ({ network, dependsOn }) =>
      gcpEdgeProvider({
        project,
        region,
        zone,
        placement: placement(network, 'proxy'),
        // The network itself, because a firewall rule attaches to one. The
        // placement carries only a subnetwork, and the two are not derivable
        // from each other by string surgery — see the note in `edge.ts`.
        network: binding(network).network,
        zoneId,
        dependsOn,
      }),
    // 64 alphanumeric characters: the value travels through a systemd
    // EnvironmentFile and a JSON payload, and punctuation would drag quoting
    // rules into both.
    mintRunnerToken: (name) => new random.RandomPassword(name, { length: 64, special: false }).result,
    runners: ({ network, adminApiKey, regionId, dependsOn }) =>
      gcpRunnerProvider({
        project,
        zone,
        placement: placement(network, 'runner'),
        adminApiKey,
        regionId,
        dependsOn,
      }),
    alarms: ({ subjects }) => gcpAlarmProvider({ subjects, project, notificationChannels }),
  }
}
