/*
 * The collector as a Cloud Run service with internal ingress.
 *
 * `INGRESS_TRAFFIC_INTERNAL_ONLY` is this cloud's answer to the AWS side's
 * internal load balancer, and it means the same thing: OTLP carries no
 * credential of its own, so anything that can reach this endpoint can write
 * telemetry attributed to anything. Internal-only is what makes the network the
 * boundary.
 *
 * Direct VPC egress rather than a connector. A connector is a pair of billed
 * instances that exist to forward packets; direct egress puts the revision's
 * own interface in the subnet, which is both cheaper and one fewer thing to
 * size. It needs the subnet to allow Google's private access, which the network
 * module set.
 *
 * One port, not two. The AWS side listens on OTLP and on a second port its load
 * balancer probes, because a target group needs somewhere to ask. Cloud Run
 * decides health from the container's own startup and liveness probes, so the
 * health extension's port has nothing to answer here — and exposing it would be
 * a second listener nothing calls.
 */

import type { ClickHouse } from '../../clickhouse.ts'
import { CLICKHOUSE_PASSWORD_VARIABLE } from '../../clickhouse.ts'
import type { Collector, CollectorProvider, CollectorRequest } from '../../collector.ts'
import { OTLP_HTTP_PORT } from '../../collector.ts'
import type { Placement } from '../../network.ts'
import { containerEnvironment, secretIdOf } from './secret-env.ts'
import { instanceFor } from 'naming'

export const gcpCollectorProvider =
  ({
    project,
    region,
    placement,
    clickhouse,
    dependsOn,
  }: {
    project: string
    region: string
    placement: Extract<Placement, { cloud: 'gcp' }>
    clickhouse: ClickHouse
    dependsOn: any[]
  }): CollectorProvider =>
  (request: CollectorRequest): Collector => {
    const name = instanceFor({ app: $app.name, stage: $app.stage, artifact: 'otel-collector' })

    /*
     * Every name handed over by reference, and the grants derived from it.
     *
     * The same shape as `api.ts`, and for the same reason: a reference the
     * platform cannot resolve is not a container that starts and logs about it,
     * it is a create Cloud Run refuses outright. The API's list and this one had
     * both grown a password the stack itself mints with no grant beside it.
     */
    const addresses: Record<string, $util.Input<string>> = {
      ...request.secrets,
      ...(clickhouse.active ? { [CLICKHOUSE_PASSWORD_VARIABLE]: clickhouse.writer.passwordRef } : {}),
    }
    const readable = Object.keys(addresses).map(
      (variable) =>
        new gcp.secretmanager.SecretIamMember(`OtelCollectorSecretAccess-${variable}`, {
          project,
          secretId: $util.output(addresses[variable] as $util.Input<string>).apply((reference: string) =>
            secretIdOf(reference),
          ),
          role: 'roles/secretmanager.secretAccessor',
          member: placement.serviceAccount.apply((email: string) => `serviceAccount:${email}`),
        }),
    )

    const service = new gcp.cloudrunv2.Service(
      'OtelCollector',
      {
        name,
        project,
        location: region,
        ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
        template: {
          serviceAccount: placement.serviceAccount,
          vpcAccess: {
            egress: 'PRIVATE_RANGES_ONLY',
            networkInterfaces: [{ subnetwork: placement.subnetwork }],
          },
          containers: [
            {
              image: request.image,
              args: [
                '--config',
                '/otelcol/collector-config.yaml',
                '--set',
                `service::pipelines::traces::exporters=${request.exporters}`,
                '--set',
                `service::pipelines::metrics::exporters=${request.exporters}`,
                '--set',
                `service::pipelines::logs::exporters=${request.exporters}`,
              ],
              ports: [{ name: 'http1', containerPort: OTLP_HTTP_PORT }],
              envs: containerEnvironment({ values: request.environment, addresses }),
            },
          ],
        },
      },
      // The grants among them: the revision resolves every reference as it is
      // created, so one landing afterwards lands after the refusal.
      { dependsOn: [...dependsOn, ...readable] },
    )

    /*
     * The network is the boundary here, as it is on AWS.
     *
     * OTLP carries no credential of its own, so authorising per caller means
     * every sender has to mint a Google ID token for this service's address —
     * a Cloud Run-shaped concern pushed into the collector's clients, one
     * implementation per language, for a service whose ingress already admits
     * nothing from outside the VPC. The AWS side puts the same collector behind
     * an internal load balancer that authorises nobody, and this now matches it.
     *
     * What that costs is worth stating plainly: anything that reaches this
     * network can write telemetry attributed to anything. `ingress` above is
     * the whole of the restriction, so widening it is what must never happen
     * quietly — the two lines are a pair.
     */
    const invoker = new gcp.cloudrunv2.ServiceIamMember('OtelCollectorInvoker', {
      project,
      location: region,
      name: service.name,
      role: 'roles/run.invoker',
      member: 'allUsers',
    })

    return {
      // Cloud Run answers on 443 with no port suffix, so unlike the AWS side
      // there is nothing to append: the URI is the endpoint.
      otlpUrl: service.uri,
      ready: [service, invoker, ...readable],
    }
  }
