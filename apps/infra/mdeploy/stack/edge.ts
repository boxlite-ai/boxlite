/*
 * The box proxy: how a port inside a box becomes a hostname on the internet.
 *
 * `<port>-<boxid>.<domain>` resolves to this, and it asks the API which runner
 * holds that box before it forwards a byte. Two consequences shape the
 * contract, and both are why this module is not just another service.
 *
 * The first is the wildcard. One certificate has to answer for every box that
 * will ever exist, so the domain is a request rather than something derived
 * from the service — and a stage whose DNS zone cannot be written is a stage
 * where no box is reachable, which is worth failing the deploy over.
 *
 * The second is that TLS terminates at the *balancer* on both clouds, and the
 * container is handed plaintext. That is what an NLB `443/tls` listener does on
 * AWS and what a target SSL proxy does on GCP, and it is safe because the
 * routing reads the Host header rather than SNI — a Host header survives
 * termination. `protocol` is therefore what the proxy composes URLs with, not
 * something it negotiates: the balancer already did that.
 *
 * Worth stating because the opposite was written here for a while, and the GCP
 * provider was built as a real passthrough to honour it. Nothing in
 * `apps/proxy` can obtain a certificate — it serves two files something else
 * must place — so a passthrough left every box hostname failing its handshake.
 *
 * The topology is protected on both clouds. A replacement that swapped the
 * listener before the new target was attached would take every running box
 * offline, and a rolling revision of the container never needs one.
 */

import type { Placement } from './network.ts'
import type { WorkloadHost } from './cluster.ts'

export type EdgeRequest = {
  image: $util.Input<string>
  /** The zone `*.<domain>` is written into. Every box is a name under it. */
  domain: string
  /** What the proxy speaks to a box: `http` or `https`. */
  protocol: string
  /** Where it asks which runner holds a box. */
  apiUrl: $util.Input<string>
  environment: Record<string, $util.Input<string>>
  secrets: Record<string, $util.Input<string>>
}

export type EdgeDependencies = {
  host: WorkloadHost
  placement: Placement
  /** Nothing may be routed to before the API can answer a lookup. */
  dependsOn: any[]
}

export type Edge = {
  /** The wildcard's apex, which the API hands to a client composing a box URL. */
  url: $util.Output<string>
  /** What this cloud's monitoring knows the proxy by. See `Api.metricTarget`. */
  metricTarget: $util.Output<string>
  ready: any[]
}

export type EdgeProvider = (request: EdgeRequest) => Edge

/** The port the proxy container listens on. The same on both clouds. */
export const PROXY_PORT = 4000
