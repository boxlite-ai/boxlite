/*
 * Somewhere for each containerised workload to run.
 *
 * This is the module where the two clouds disagree most, and the contract says
 * so rather than hiding it. ECS needs a cluster before it can place a task, and
 * the cluster is where the network placement and the service-discovery
 * namespace are fixed. Cloud Run has no cluster: a service names a region and a
 * service account and that is the whole of it, both of which the placement
 * already carries. The proxy is the exception: it needs a TCP backend that can
 * hold long-lived connections, so GCP places that one role in GKE while the API
 * and collector remain on Cloud Run.
 *
 * The runner is not here. It is a virtual machine with nested KVM rather than a
 * container, so it has no host to be placed in on either cloud — it *is* the
 * host. `runners.ts` takes a placement straight from the network for that
 * reason, and asking this module for one would have meant a cluster with no
 * tasks in it on AWS and nothing at all on GCP.
 */

import type { WorkloadRole } from './network.ts'

/** The roles this module can be asked for: everything except the runner. */
export type ContainerRole = Exclude<WorkloadRole, 'runner'>

export type ClusterRequest = {
  /** The roles that need somewhere to run. */
  roles: readonly ContainerRole[]
}

/**
 * What a workload is deployed into. GCP deliberately exposes its two runtimes:
 * pretending Cloud Run and GKE are one shape would make a caller discover the
 * difference through missing fields halfway through a deploy.
 */
export type WorkloadHost =
  | { cloud: 'aws'; cluster: CloudResource }
  | { cloud: 'gcp'; runtime: 'cloud-run'; region: string }
  | {
      cloud: 'gcp'
      runtime: 'gke'
      region: string
      /**
       * Every zone the cluster runs nodes in, which is every zone a standalone
       * NEG can appear in.
       *
       * A list rather than one zone: an Autopilot cluster is regional and places
       * Pods wherever the region has room, so a backend built from a single
       * zone would carry whichever third of the fleet happened to land there
       * and silently drop the rest.
       */
      zones: $util.Output<string[]>
      /** The explicit provider every Kubernetes resource must use. */
      provider: CloudResource
      /** Firewall rules identify GKE traffic by the node VM identity. */
      nodeServiceAccount: $util.Output<string>
      /** Resources that must exist before a Pod can be scheduled. */
      ready: any[]
    }

export type Cluster = {
  hostFor: (role: ContainerRole) => WorkloadHost
  ready: any[]
}

export type ClusterProvider = (request: ClusterRequest) => Cluster
