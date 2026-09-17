/*
 * Two GCP container hosts, because the workloads need two different things.
 *
 * The API and collector remain Cloud Run services. The proxy runs on GKE: a
 * standalone zonal NEG can be attached to the existing global TCP/SSL proxy
 * load balancer, and a Pod can mount Secret Manager without copying its payload
 * into a Kubernetes Secret.
 *
 * The cluster has a regional control plane but keeps its two nodes in the
 * stage's declared zone. That matches the old two-instance failure domain and
 * avoids paying for six nodes merely because a regional node count is per zone.
 * The host records the zone explicitly, so spreading later is an intentional
 * change to both the node pool and the edge's backend list.
 */

import type { Cluster, ClusterProvider, ContainerRole, WorkloadHost } from '../../cluster.ts'
import type { Network, NetworkBinding } from '../../network.ts'
import { GKE_POD_RANGE, GKE_SERVICE_RANGE } from './network.ts'
import { identityFor, instanceFor } from 'naming'

const MASTER_CIDR = '172.16.0.0/28'

/** A kubeconfig that uses the deployer's short-lived Google OAuth token. */
export const kubeconfigFor = ({
  name,
  endpoint,
  certificateAuthority,
  token,
}: {
  name: string
  endpoint: string
  certificateAuthority: string
  token: string
}): string =>
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name, cluster: { server: `https://${endpoint}`, 'certificate-authority-data': certificateAuthority } }],
    contexts: [{ name, context: { cluster: name, user: name } }],
    'current-context': name,
    users: [{ name, user: { token } }],
  })

export const gcpClusterProvider =
  ({
    project,
    region,
    appShort,
    network,
  }: {
    project: string
    region: string
    appShort: string
    network: Network
  }): ClusterProvider =>
  (request): Cluster => {
    const cloudRun: WorkloadHost = { cloud: 'gcp', runtime: 'cloud-run', region }
    if (!request.roles.includes('proxy')) {
      return { hostFor: () => cloudRun, ready: network.ready }
    }

    const binding = network.binding as Extract<NetworkBinding, { cloud: 'gcp' }>
    if (binding.cloud !== 'gcp') throw new Error(`The GCP cluster was handed ${binding.cloud} network`)

    const nodeAccount = new gcp.serviceaccount.Account('ProxyNodeServiceAccount', {
      project,
      accountId: identityFor({ appShort, stage: $app.stage, artifact: 'gke', action: 'node' }),
      displayName: `BoxLite GKE proxy nodes (${$app.stage})`,
    })
    const nodeRuntime = new gcp.projects.IAMMember('ProxyNodeRuntime', {
      project,
      role: 'roles/container.defaultNodeServiceAccount',
      member: nodeAccount.email.apply((email: string) => `serviceAccount:${email}`),
    })
    const nodeRegistry = new gcp.projects.IAMMember('ProxyNodeRegistryReader', {
      project,
      role: 'roles/artifactregistry.reader',
      member: nodeAccount.email.apply((email: string) => `serviceAccount:${email}`),
    })

    /*
     * Autopilot: Google runs the nodes, this file runs none.
     *
     * The proxy is two or three stateless Pods whose size is known and whose
     * count changes rarely, which is exactly the shape a node pool costs more
     * to operate than to own — a pool means machine types, upgrades, repair
     * windows and a capacity decision made in whole `e2-standard-2` units.
     * Autopilot charges for the Pod's own requests and provisions whatever
     * carries them.
     *
     * What it does *not* do is change the replica count: node capacity follows
     * the Pods, and the Pods follow `REPLICAS` in `edge.ts` until something
     * gives the proxy a connection-aware HPA.
     */
    const cluster = new gcp.container.Cluster('ProxyCluster', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      location: region,
      network: binding.network,
      subnetwork: binding.subnetwork,
      networkingMode: 'VPC_NATIVE',
      ipAllocationPolicy: {
        clusterSecondaryRangeName: GKE_POD_RANGE,
        servicesSecondaryRangeName: GKE_SERVICE_RANGE,
      },
      enableAutopilot: true,
      deletionProtection: false,
      /*
       * The identity Autopilot's own nodes run as.
       *
       * `autoProvisioningDefaults` is where an Autopilot cluster takes what a
       * node pool would otherwise carry: without it the nodes fall back to the
       * project's default Compute service account, which this project grants
       * far more than pulling one image and writing logs.
       */
      clusterAutoscaling: {
        autoProvisioningDefaults: {
          serviceAccount: nodeAccount.email,
          oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      },
      releaseChannel: { channel: 'REGULAR' },
      /*
       * Dataplane V2, which is what makes a NetworkPolicy mean anything.
       *
       * Autopilot runs it unconditionally, and stating it here is the line a
       * reader of `edge.ts`'s default-deny can check: a policy on a cluster with
       * no engine is accepted by the API server and enforced by nothing.
       */
      datapathProvider: 'ADVANCED_DATAPATH',
      privateClusterConfig: {
        enablePrivateNodes: true,
        enablePrivateEndpoint: false,
        masterIpv4CidrBlock: MASTER_CIDR,
      },
      workloadIdentityConfig: { workloadPool: `${project}.svc.id.goog` },
      /*
       * Off, and named rather than dropped.
       *
       * The add-on installed a CSI driver for one reader, the proxy's secret
       * volume, and that volume is gone — the stack writes the Kubernetes
       * Secret itself. Deleting the property rather than setting it turned the
       * diff into `-secretManagerConfig`, and the provider then sent a cluster
       * update naming no field at all: `googleapi: Error 400: Must specify a
       * field to update`. An update has to ask for something.
       */
      secretManagerConfig: { enabled: false },
      loggingConfig: { enableComponents: ['SYSTEM_COMPONENTS', 'WORKLOADS'] },
      monitoringConfig: { enableComponents: ['SYSTEM_COMPONENTS'] },
    })

    const client = gcp.organizations.getClientConfigOutput({}, { dependsOn: [cluster] })
    const kubeconfig = $util.secret(
      $resolve([
        cluster.name,
        cluster.endpoint,
        cluster.masterAuth.clusterCaCertificate,
        client.accessToken,
      ]).apply(([name, endpoint, certificateAuthority, token]: string[]) =>
        kubeconfigFor({ name, endpoint, certificateAuthority, token }),
      ),
    )
    const provider = new kubernetes.Provider(
      'ProxyKubernetes',
      { kubeconfig, clusterIdentifier: cluster.id },
      { dependsOn: [cluster] },
    )

    const gke: WorkloadHost = {
      cloud: 'gcp',
      runtime: 'gke',
      region,
      // Reported by the cluster rather than declared here: Autopilot decides
      // where a Pod fits, and the NEGs follow the Pods.
      zones: cluster.nodeLocations,
      provider,
      nodeServiceAccount: nodeAccount.email,
      ready: [cluster, nodeRuntime, nodeRegistry],
    }
    return {
      hostFor: (role: ContainerRole) => (role === 'proxy' ? gke : cloudRun),
      /*
       * The network's rules all the same.
       *
       * Cloud Run should not wait for the GKE control plane: only the proxy
       * consumes `gke.ready`. The common list remains the network rules every
       * workload needs.
       */
      ready: network.ready,
    }
  }
