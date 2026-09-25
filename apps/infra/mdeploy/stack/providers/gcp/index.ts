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
 * Applied against real projects: `dev` and `prod`, both in `us-east5`.
 */

import type { StackProviders } from '../../index.ts'
import type { WorkloadHost } from '../../cluster.ts'
import type { Network, NetworkBinding, Placement } from '../../network.ts'
import { gcpImages } from '../../image.ts'
import { gcpAlarmProvider } from './alarms.ts'
import { gcpApiProvider } from './api.ts'
import { gcpCacheProvider } from './cache.ts'
import { gcpClickHouseProvider } from './clickhouse.ts'
import { gcpClusterProvider } from './cluster.ts'
import { gcpCollectorProvider } from './collector.ts'
import { gcpDatabaseProvider } from './database.ts'
import { gcpEdgeProvider } from './edge.ts'
import { gcpMailProvider } from './mail.ts'
import { CLOUDRUN_EGRESS_CIDR, gcpNetworkProvider } from './network.ts'
import { gcpRunnerProvider } from './runners.ts'
import { gcpStorageProvider } from './storage.ts'

const onGcp = <T extends { cloud: string }>(value: T, what: string): Extract<T, { cloud: 'gcp' }> => {
  if (value.cloud !== 'gcp') throw new Error(`The GCP stack was handed ${value.cloud} ${what}`)
  return value as Extract<T, { cloud: 'gcp' }>
}

const binding = (network: Network): Extract<NetworkBinding, { cloud: 'gcp' }> => onGcp(network.binding, 'network')
const placement = (network: Network, role: Parameters<Network['placementFor']>[0]): Extract<Placement, { cloud: 'gcp' }> =>
  onGcp(network.placementFor(role), 'placement')
const gkeHost = (host: WorkloadHost): Extract<WorkloadHost, { cloud: 'gcp'; runtime: 'gke' }> => {
  const value = onGcp(host, 'host')
  if (value.runtime !== 'gke') throw new Error(`The GCP proxy was handed ${value.runtime} host`)
  return value
}

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
  dashboardDomain = null,
  zoneId,
  relayHost = null,
  artifactsBucket,
  volumePrefix,
  managedClickHouse = null,
  clickStackConsumer = null,
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
  /** The stage's own domain. `api.<domain>` is where the control plane answers. */
  domain: string
  /** Where the dashboard is served, or null for the stage domain itself. */
  dashboardDomain?: string | null
  /** The Cloudflare zone every public record is written into. */
  zoneId: string
  /** The SMTP relay a GCP stage sends through. Google provides none. */
  relayHost?: string | null
  /** Where a build-mode runner binary is staged, which the hosts are let read. */
  artifactsBucket: string
  /**
   * What a volume bucket is named. The storage module bounds the API with it;
   * the runners module bounds the hosts that mount with the same sentence.
   */
  volumePrefix: string
  managedClickHouse?: { url: string; writerSecretArn: string; readerSecretArn: string } | null
  /** Who may read the ClickHouse reader password; see `clickstack.ts`. */
  clickStackConsumer?: string | null
  notificationChannels?: string[]
}): StackProviders => {
  const zone = zoneIn(region, declaredZone)

  return {
    images: gcpImages({ stage, region, project }),
    network: gcpNetworkProvider({ project, region, appShort }),
    storage: gcpStorageProvider({ project, region, appShort }),
    // Cloud Run hosts the API and collector; GKE exists only for the proxy.
    cluster: ({ network }) => gcpClusterProvider({ project, region, appShort, network }),
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
        region,
        zone,
        appShort,
        // The collector writes and the API reads, and the rule admits those two
        // and nothing else. By range because both are Cloud Run services, which
        // arrive with neither an account nor a tag a rule can match; the subnet
        // holds exactly those two, so one range cannot name half of them the way
        // a hand-written caller list once did.
        callerRanges: [CLOUDRUN_EGRESS_CIDR],
        // The one project allowed to connect an endpoint. Today the console is
        // deployed into this same project, so the producer's own id is the
        // accept list; the identity that reads the password is stage
        // configuration already, because it is the one of the two that differs
        // between an app's own consumer and somebody else's.
        clickStackConsumerProject: project,
        clickStackConsumerAccount: clickStackConsumer,
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
        dependsOn,
      }),
    api: ({ dependencies, network }) =>
      gcpApiProvider({
        dependencies,
        project,
        region,
        domain,
        dashboardDomain,
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
    // Not a Cloud Run service: the proxy is a GKE workload behind a standalone
    // NEG attached to the existing global SSL proxy load balancer.
    edge: ({ host, network, dependsOn }) =>
      gcpEdgeProvider({
        project,
        host: gkeHost(host),
        placement: placement(network, 'proxy'),
        // The network itself, because a firewall rule attaches to one. The
        // placement carries only a subnetwork, and the two are not derivable
        // from each other by string surgery — see the note in `edge.ts`.
        network: binding(network).network,
        runnerServiceAccount: placement(network, 'runner').serviceAccount,
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
        artifactsBucket,
        volumePrefix,
        adminApiKey,
        regionId,
        dependsOn,
      }),
    alarms: ({ subjects }) => gcpAlarmProvider({ subjects, project, notificationChannels }),
  }
}
