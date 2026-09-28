/*
 * Publishing the ClickHouse host as a service another VPC can consume.
 *
 * The host itself is one VM with no external address, reachable only from
 * inside `boxlite-app-<stage>`. The backoffice console lives in a different
 * network and needs the read-only interface on 8123 — and nothing else in this
 * network. Private Service Connect is what makes "one service" the unit: the
 * consumer creates an endpoint against this attachment and gets exactly the
 * port published here, where a VPC peering would hand over every runner and
 * proxy address along with it.
 *
 * The chain is longer than it looks because an attachment cannot name a VM:
 *
 *   service attachment → forwarding rule → backend service → instance group → VM
 *
 * Each hop exists for a reason stated at the resource. The consumer sees only
 * the first one, by name, and the name is a contract — see the attachment
 * below.
 */

import { PSC_NAT_CIDR } from './network.ts'
import { instanceFor } from 'naming'

/**
 * How many endpoints may connect before the attachment refuses more.
 *
 * One consumer is expected — backoffice's console — and a limit far above that
 * would make an accidental second publication look like normal operation.
 */
const CONNECTION_LIMIT = 10

/**
 * The ranges Google's own health probes come from.
 *
 * Documented rather than discoverable: a probe arrives from Google's
 * infrastructure, not from anything in this project, so no service account can
 * name it and the backend stays UNHEALTHY until these two are admitted.
 */
const HEALTH_PROBE_RANGES = ['35.191.0.0/16', '130.211.0.0/22']

/**
 * The ClickStack publication: everything between the ClickHouse VM and a
 * consumer's endpoint.
 *
 * Returns nothing: the publication is reached by name, not by handle. Nothing
 * in this stack consumes it — the consumer is in another repository and finds
 * the attachment by the name below — so a returned handle would be a value no
 * call site could have a use for.
 */
export const publishClickStack = ({
  project,
  region,
  zone,
  network,
  subnetwork,
  instanceLink,
  hostAccount,
  port,
  consumerProject,
  consumerAccount,
  readerSecretId,
  dependsOn,
}: {
  project: string
  region: string
  zone: string
  network: $util.Input<string>
  subnetwork: $util.Input<string>
  /** The ClickHouse VM, by self link: what the instance group holds. */
  instanceLink: $util.Input<string>
  /** The identity the VM runs as, which the firewall rule below targets. */
  hostAccount: $util.Input<string>
  /**
   * The port to publish, handed in rather than restated.
   *
   * `clickhouse.ts` owns this number: it renders it into the server's own
   * `<http_port>`, so a second copy here would keep the health check, the
   * forwarding rule and the firewall on 8123 while the server moved — three
   * resources healthy against a port nothing listens on.
   */
  port: number
  /**
   * The project allowed to connect an endpoint to this attachment.
   *
   * A project rather than an identity, because that is the unit PSC accepts:
   * whoever creates an endpoint in it may connect. In `dev` the console shares
   * this project with the producer, so the two are the same value — and stating
   * it as a parameter keeps the day they diverge a configuration change here
   * rather than a rewrite of the attachment.
   */
  consumerProject: string
  /**
   * The consumer's own identity, let read the reader password — or null, for a
   * publication nobody consumes yet.
   *
   * A separate coordinate from the project above because the two answer
   * different questions: the project decides whose endpoint may open a
   * connection, this decides who may authenticate over it. Neither implies the
   * other, and a stage that publishes to another organisation sets both.
   */
  consumerAccount: string | null
  /** The reader password's secret, which is what `consumerAccount` is let read. */
  readerSecretId: $util.Input<string>
  dependsOn: any[]
}) => {
  const name = instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickstack' })

  /*
   * The NAT subnet, which holds no instance.
   *
   * A consumer's connection enters this network translated into an address from
   * this range — that is the whole purpose of a `PRIVATE_SERVICE_CONNECT`
   * subnet, and why neither the workload subnet nor the managed-proxy one can
   * be reused: a subnet has exactly one purpose, and both of those already have
   * a different one.
   */
  const natSubnet = new gcp.compute.Subnetwork('ClickStackNatSubnet', {
    name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'clickstack-nat' }),
    project,
    region,
    network,
    ipCidrRange: PSC_NAT_CIDR,
    purpose: 'PRIVATE_SERVICE_CONNECT',
  })

  /*
   * An unmanaged group holding the one VM.
   *
   * A backend service takes groups, not instances, and this VM is not a member
   * of any: it is created directly, with a retained data disk, because
   * telemetry storage is not a thing to be replaced on a template change. An
   * unmanaged group is the adapter between those two facts — it adds no
   * autoscaling, no template and no replacement, only membership.
   */
  const group = new gcp.compute.InstanceGroup('ClickStackGroup', {
    name,
    project,
    zone,
    network,
    instances: [instanceLink],
  })

  /*
   * A TCP check on the published port rather than an HTTP one on `/ping`.
   *
   * ClickHouse answers `/ping` without credentials, so an HTTP check would work
   * — and would also make the health of the publication depend on a URL the
   * server could rename. What this check must prove is that the port accepts
   * connections; the console's own queries prove the rest.
   */
  const health = new gcp.compute.RegionHealthCheck('ClickStackHealth', {
    name,
    project,
    region,
    tcpHealthCheck: { port },
  })

  /*
   * An internal passthrough balancer, which is what a service attachment can
   * target.
   *
   * `INTERNAL` rather than the `INTERNAL_MANAGED` scheme `api.ts` uses: a
   * managed one terminates the connection on an Envoy and speaks HTTP, and the
   * console's traffic is opaque TCP that should arrive at ClickHouse as it was
   * sent. Passthrough also means no second place to configure a timeout.
   */
  const backend = new gcp.compute.RegionBackendService('ClickStackBackend', {
    name,
    project,
    region,
    network,
    loadBalancingScheme: 'INTERNAL',
    protocol: 'TCP',
    healthChecks: [health.id],
    // Stated, because the provider's default is the one an `INTERNAL` service
    // refuses: `UTILIZATION` is answered with a 400 naming the field, and a
    // passthrough balancer has no requests to rate-limit — it counts
    // connections. `edge.ts` says the same thing about its own backend.
    backends: [{ group: group.id, balancingMode: 'CONNECTION' }],
  })
  const forwarding = new gcp.compute.ForwardingRule('ClickStackForwardingRule', {
    name,
    project,
    region,
    network,
    subnetwork,
    loadBalancingScheme: 'INTERNAL',
    backendService: backend.id,
    ports: [String(port)],
  })

  /*
   * The traffic that arrives by address instead of by identity.
   *
   * `clickhouse.ts`'s rule admits the collector and the API by the range they
   * egress from, which covers every caller inside this network. Neither kind of
   * packet here comes from it: a health probe originates in Google's own
   * infrastructure, and a consumer's connection has been translated into the
   * NAT range above, losing whatever the consumer carried on the way in.
   * Without this rule the backend never turns healthy and the console connects
   * to nothing.
   */
  const firewall = new gcp.compute.Firewall('ClickStackFirewall', {
    name,
    project,
    network,
    direction: 'INGRESS',
    allows: [{ protocol: 'tcp', ports: [String(port)] }],
    sourceRanges: [...HEALTH_PROBE_RANGES, PSC_NAT_CIDR],
    targetServiceAccounts: [hostAccount],
  })

  /*
   * The publication itself, and the only switch the consumer sees.
   *
   * The name is a contract: backoffice's preflight discovers this publication by
   * looking for exactly `<app>-<stage>-clickstack` and derives both coordinates
   * from finding it, so respelling this moves a resource *and* silently
   * unpublishes the console's data source.
   *
   * `ACCEPT_MANUAL` with one project on the list, rather than `ACCEPT_AUTOMATIC`:
   * automatic means any project in the organization may connect an endpoint to
   * this ClickHouse, which is a wider grant than the firewall above gives
   * anybody inside the network.
   */
  new gcp.compute.ServiceAttachment(
    'ClickStackAttachment',
    {
      name,
      project,
      region,
      targetService: forwarding.id,
      natSubnets: [natSubnet.id],
      connectionPreference: 'ACCEPT_MANUAL',
      consumerAcceptLists: [{ projectIdOrNum: consumerProject, connectionLimit: CONNECTION_LIMIT }],
      // Proxy protocol prepends the consumer's endpoint address to the stream.
      // ClickHouse would read those bytes as the first line of a request.
      enableProxyProtocol: false,
    },
    { dependsOn: [...dependsOn, firewall] },
  )

  /*
   * The other half of the publication: the credential.
   *
   * A connection without a password reaches a ClickHouse that refuses it, so
   * the grant belongs here rather than wherever the secret is created — this
   * module is the one place that answers "what does the consumer get". The
   * grant is on that one secret: `secretAccessor` on a secret is every version
   * of it and nothing else in the project, which is why rotation needs no
   * second act here.
   *
   * Read rather than copied. A copy in the consumer's own boundary — what the
   * AWS path does, because cross-account Secrets Manager needs a resource
   * policy and a KMS grant — has a lifecycle of its own: BoxLite rotates, the
   * copy does not, and the panel connects and then fails to authenticate.
   */
  if (consumerAccount) {
    new gcp.secretmanager.SecretIamMember('ClickStackReaderAccess', {
      project,
      secretId: readerSecretId,
      role: 'roles/secretmanager.secretAccessor',
      member: `serviceAccount:${consumerAccount}`,
    })
  }
}
