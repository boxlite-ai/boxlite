/*
 * The registry proxy as a Cloud Run service with internal ingress.
 *
 * The collector's shape, for the collector's reason: a caller this proxy serves
 * cannot present a Google identity. The runtime that pulls through it speaks
 * the registry protocol, whose Authorization header already carries the
 * runner's own Basic credential — so Cloud Run's per-request IAM check has
 * nothing it could read, and the invoker has to be `allUsers`. What restricts
 * the service is the ingress, and what authenticates each caller is the proxy
 * itself, which asks the control plane about every runner key it is handed.
 *
 * No load balancer. A runner is a VM in this network, and a VM on a subnet with
 * Google's private access reaches an internal-ingress service at its own
 * `run.app` address without leaving Google's network — the path runners
 * already take to the collector. A balancer would add a certificate, a name and
 * a DNS record to reach something that is already reachable.
 *
 * Three settings differ from the collector, and each is here because the
 * default loses a pull rather than because it is tidier:
 *
 * - The request deadline is an hour. A blob is one response, a large layer
 *   takes minutes to stream, and Cloud Run's default of five cuts it off.
 * - The port speaks HTTP/2 in the clear. Cloud Run caps an HTTP/1 response at
 *   32 MiB unless it is chunked, and a blob relayed with the upstream's own
 *   Content-Length is not — so over HTTP/1, every layer past that size would
 *   fail here and nowhere else. The binary accepts both on one port.
 * - The process is probed. A proxy that wedges while its listener stays open
 *   accepts pulls it never answers; a liveness probe on its own health route is
 *   what gets it replaced.
 */

import type { Placement } from '../../network.ts'
import type { RegistryProxy, RegistryProxyProvider, RegistryProxyRequest } from '../../registry-proxy.ts'
import { REGISTRY_PROXY_HEALTH_PATH, REGISTRY_PROXY_PORT } from '../../registry-proxy.ts'
import { containerEnvironment } from './secret-env.ts'
import { instanceFor } from 'naming'

export const gcpRegistryProxyProvider =
  ({
    project,
    region,
    placement,
    dependsOn,
  }: {
    project: string
    region: string
    /** Its own role's placement, so the identity it runs as is its own. */
    placement: Extract<Placement, { cloud: 'gcp' }>
    dependsOn: any[]
  }): RegistryProxyProvider =>
  (request: RegistryProxyRequest): RegistryProxy => {
    const probe = { httpGet: { path: REGISTRY_PROXY_HEALTH_PATH, port: REGISTRY_PROXY_PORT } }

    const service = new gcp.cloudrunv2.Service(
      'RegistryProxy',
      {
        name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'registry-proxy' }),
        project,
        location: region,
        /*
         * The whole of the restriction, because the invoker below admits
         * everyone. Read the note on that invoker before widening this: the two
         * are one decision.
         */
        ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
        // Stateless, so protection buys nothing — and left on, the provider
        // refuses the delete half of a rename. See the same line in `api.ts`.
        deletionProtection: false,
        template: {
          serviceAccount: placement.serviceAccount,
          // An hour, which is also the most Cloud Run allows. See the note above.
          timeout: '3600s',
          /*
           * Into the network for private destinations only, which is the
           * control plane: inside it, `api.<domain>` resolves to the internal
           * balancer. Upstream registries are public and go out Cloud Run's own
           * egress, which is where they are reachable from anyway.
           *
           * From the workload subnet, not `egressSubnetwork`. Every rule that
           * admits a Cloud Run service to a VM is keyed on that range, so
           * egressing from it would open the runners and ClickHouse to a relay
           * that calls neither. The internal balancer answers from here too.
           */
          vpcAccess: {
            egress: 'PRIVATE_RANGES_ONLY',
            networkInterfaces: [{ subnetwork: placement.subnetwork }],
          },
          containers: [
            {
              image: request.image,
              ports: [{ name: 'h2c', containerPort: REGISTRY_PROXY_PORT }],
              startupProbe: probe,
              livenessProbe: probe,
              envs: containerEnvironment({ values: request.environment, addresses: {} }),
            },
          ],
        },
      },
      { dependsOn },
    )

    /*
     * Everyone, and on purpose.
     *
     * A caller here is the runtime pulling an image, and its Authorization
     * header is the registry protocol's own: the runner's Basic credential,
     * which this proxy checks against the control plane on every request. There
     * is no second header to carry a Google identity token in, so a named
     * invoker would authorise nothing that ever calls — the same shape of
     * failure `api.ts` describes, where every service account can reach the
     * service and the one caller that matters cannot.
     *
     * `ingress` above is the restriction. Widening it beside this line is a
     * one-word edit that puts an authenticated relay on the internet.
     */
    const invoker = new gcp.cloudrunv2.ServiceIamMember('RegistryProxyInvoker', {
      project,
      location: region,
      name: service.name,
      role: 'roles/run.invoker',
      member: 'allUsers',
    })

    return {
      active: true,
      // Cloud Run answers on 443 with no port suffix, so the URI is the origin.
      url: service.uri,
      ready: [service, invoker],
    }
  }
