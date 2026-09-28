/*
 * The GCP network: one VPC, a Cloud Router with NAT, and one service account
 * per role.
 *
 * The service accounts are where this differs most from AWS, and the difference
 * is the deepest one between the two clouds. AWS answers *who may reach this*
 * with position — a security group says which tasks reach the API, and being in
 * it is the whole of the permission. Google answers with identity: a Cloud Run
 * service admits one named invoker, a firewall rule keys on a service account,
 * and a database grants an account. So a placement here carries an identity
 * where the AWS one carries a group, and this module is where those identities
 * are created — because a role's identity has to exist before anything that
 * grants to it does.
 *
 * Private Service Access is the other thing with no AWS counterpart. Cloud SQL
 * and Memorystore are Google-managed and live in Google's own project; reaching
 * them on a private address needs a peering between this network and that one,
 * with a reserved range for it. Nothing can take a private address until the
 * peering exists, so it is in `ready`.
 *
 * The runner's placement is `private` here where AWS makes it
 * `egress-only-public`, and that is an organization policy rather than a
 * preference: `constraints/compute.vmExternalIpAccess` refuses an instance that
 * asks for an external address, so every workload's outbound goes through Cloud
 * NAT. Three ingress rules name the runner and each keys on what its own caller
 * is: the control plane's on the serverless egress range below, the proxy's on
 * the GKE Pod range in `edge.ts`, and IAP's on Google's tunnel range for port
 * 22. Nothing else reaches it.
 *
 * Identity has one hole, and it is the reason `CLOUDRUN_EGRESS_CIDR` exists: a
 * Cloud Run service's direct-egress packets arrive attributed to no service
 * account, so a rule that admits one *by identity* admits nothing. Google offers
 * no label for them either — a network tag in an ingress rule is unsupported for
 * direct VPC egress — so the only source that reaches them is the range they
 * leave from. Every rule from a Cloud Run workload to a VM is keyed on that
 * range: here for the runner, and in `clickhouse.ts` for the telemetry host.
 */

import { API_PORT } from '../../api.ts'
import { OTLP_HTTP_PORT } from '../../collector.ts'
import { PROXY_PORT } from '../../edge.ts'
import type { Network, NetworkProvider, NetworkRequest, Placement, WorkloadRole } from '../../network.ts'
import { RUNNER_PORT } from '../../runners.ts'
import { identityFor, instanceFor } from 'naming'

/** Every port one workload in this network opens to another. */
const INTERNAL_PORTS = [API_PORT, PROXY_PORT, RUNNER_PORT, OTLP_HTTP_PORT].map(String)

/** The subnet workloads sit in. Private Service Access gets its own below. */
export const SUBNET_CIDR = '10.20.0.0/20'

/**
 * The subnet the Cloud Run services egress from, and the source of every rule
 * that admits one to a VM.
 *
 * Its own range rather than a share of `SUBNET_CIDR`, and that is the whole
 * point of it. A rule keyed on the workload subnet would admit every runner and
 * the telemetry host itself — the widening `InternalFirewall` argues against
 * below — whereas this one holds the serverless roles and nothing that can take
 * an instance.
 *
 * What it cannot do is tell those roles apart, and that is the price of the
 * supported mechanism rather than an oversight. A rule keyed here admits the
 * control plane and the collector alike, so the runner's rule now also admits a
 * collector that has no reason to call it, and ClickHouse's admits both the
 * writer and the reader it already wanted. Narrowing further would need a subnet
 * per role, which is a range each and a placement each; it is worth doing the
 * day a serverless role appears that should not reach both hosts.
 *
 * A range because it is the only source this direction is documented to take.
 * The page that shows a Cloud Run service being given network tags — it can be,
 * and they serve in an *egress* rule — also lists "network tags or service
 * identity in ingress firewall rules" among what direct VPC egress does not
 * support: https://cloud.google.com/run/docs/configuring/vpc-direct-vpc.
 * Assignable and usable as a source are different questions, and reading the
 * first as the second is why a tag looked like it should work here.
 *
 * Measured on the dev stage on 2026-09-23, changing only this rule's source:
 *
 *   sourceServiceAccounts only   `/v1/boxes/*` exec  504 after 127.5s
 *   + the range the API egresses from                201 after 0.52s
 *
 * 127 seconds is not a coincidence: it is Linux's default connect timeout at
 * `tcp_syn_retries=6` (1+2+4+8+16+32+64), so the SYN was being dropped rather
 * than refused — a deny that sends no RST. Naming the range ends it in one
 * handshake. An identity on this rule reads correct and admits nothing.
 *
 * The tag was never measured against that pair, so it is not called broken
 * here. What this file recorded before it is the reason not to key on it
 * either: on 2026-09-20, on the same stage, a tag-keyed runner rule admitted
 * nothing for forty minutes, and waiting did not end it — rewriting the rule
 * did, and it served four minutes later. A selector that matches only
 * sometimes is what an unsupported one looks like from the outside, and a rule
 * that has to be rewritten before it starts working is not one to put a
 * control plane behind.
 *
 * A `/22`, which is the size Cloud Run's own defaults ask for. Direct VPC
 * egress holds two addresses per instance and a rollout holds both revisions'
 * at once, so two services left at the default ceiling of 100 instances each
 * want (100 + 100) × 2 × 2 = 800 addresses. The 1020 usable here — a subnet
 * reserves four of its own — carry that; a `/23` offers 508 and does not.
 *
 * Sized for the default rather than for a ceiling this file sets, so that
 * capping either service stays a decision about its own load and its database
 * connections (#1610) instead of something this range forces. The range is
 * also the more expensive half to change: it can be widened in place but
 * never narrowed, and a narrower one is a new subnet every Cloud Run revision
 * egressing through this one must be moved to.
 *
 * Too small fails in a way that names nothing: an instance that cannot start
 * for want of a free address in the subnet reads nothing like a firewall
 * problem. Widening the subnet does not widen the rule: the rule admits what
 * sits here, and only these two services are placed here.
 *
 * Placed above `PSC_NAT_CIDR` on a `/22` boundary and inside the same `/16`,
 * which is what keeps the Private Service Access allocator from ever taking
 * it; the reasoning in `MANAGED_PROXY_CIDR` covers this range unchanged. It
 * still ends well below the GKE Pod range at `10.20.32.0/19`.
 */
export const CLOUDRUN_EGRESS_CIDR = '10.20.20.0/22'

/**
 * Alias ranges used by the GKE proxy Pods and Kubernetes Services.
 *
 * Both stay inside the `/16` already made unavailable to Private Service
 * Access by `SUBNET_CIDR`, while not overlapping either primary subnet below.
 * Naming the ranges on the subnet lets the cluster adopt them instead of
 * asking GKE to create an implicit range that no firewall rule could name.
 */
export const GKE_POD_CIDR = '10.20.32.0/19'
export const GKE_SERVICE_CIDR = '10.20.64.0/22'
export const GKE_POD_RANGE = 'gke-proxy-pods'
export const GKE_SERVICE_RANGE = 'gke-proxy-services'

/**
 * The subnet the region's Envoy load balancers put their own proxies in.
 *
 * It holds no workload and is not a placement: `REGIONAL_MANAGED_PROXY` is
 * where Google runs the proxies of every regional Envoy balancer in this
 * network and region, and there may be exactly one active. So it belongs to the
 * network rather than to the balancer that needs it — `api.ts` builds the
 * internal balancer that uses it, and a second such balancer would find this
 * already here rather than colliding with its own copy.
 *
 * Adjacent to the workload range rather than carved out of it, and safe against
 * the Private Service Access range below even though that one is allocated by
 * Google: the only `/16` containing `10.20.16.0/24` is `10.20.0.0/16`, which
 * overlaps `SUBNET_CIDR`, and service networking cannot hand out a range that
 * overlaps a subnet of the network it peers with.
 */
export const MANAGED_PROXY_CIDR = '10.20.16.0/24'

/**
 * The range a Private Service Connect publication translates consumers into.
 *
 * Declared here with the other ranges rather than beside the attachment that
 * uses it, because what makes an address range correct is every other range in
 * the same network: this one sits directly above the managed-proxy subnet and
 * below the GKE ranges, and the reasoning in `MANAGED_PROXY_CIDR` about the
 * Private Service Access allocation covers it unchanged.
 *
 * `clickstack.ts` builds the subnet, since a publication owns its own NAT
 * addresses — a second publication would need a second range, not a share of
 * this one.
 */
export const PSC_NAT_CIDR = '10.20.17.0/24'

/**
 * The range reserved for Google's own managed services.
 *
 * A `/16` because Google allocates out of it per service and per region, and a
 * range too small to allocate from fails at the point a database is created
 * rather than here — with an error about the service, not about the range.
 */
const SERVICE_RANGE_PREFIX = 16

/**
 * The four identities, one per role, and the name Pulumi files each under. A
 * grant names one of these and never a range.
 *
 * A `Record` so a role added to `WorkloadRole` cannot silently go without an
 * identity. The Pulumi name is written out rather than derived from the role,
 * because it is part of the state's addressing: deriving it would move an
 * existing account the day a role is respelled. The cloud name is `naming`'s.
 */
const ACCOUNTS: Record<WorkloadRole, string> = {
  api: 'ApiServiceAccount',
  proxy: 'ProxyServiceAccount',
  'otel-collector': 'OtelServiceAccount',
  runner: 'RunnerServiceAccount',
}

export const gcpNetworkProvider =
  ({ project, region, appShort }: { project: string; region: string; appShort: string }): NetworkProvider =>
  (request: NetworkRequest): Network => {
    const network = new gcp.compute.Network('Network', {
      name: instanceFor({ app: $app.name, stage: $app.stage }),
      project,
      // Subnets are declared rather than generated: one per stage, in one
      // region, is the whole topology — and an auto-created subnet in every
      // region is twenty-odd ranges nothing uses.
      autoCreateSubnetworks: false,
    })

    const subnetwork = new gcp.compute.Subnetwork('Subnetwork', {
      name: instanceFor({ app: $app.name, stage: $app.stage }),
      project,
      region,
      network: network.id,
      ipCidrRange: SUBNET_CIDR,
      secondaryIpRanges: [
        { rangeName: GKE_POD_RANGE, ipCidrRange: GKE_POD_CIDR },
        { rangeName: GKE_SERVICE_RANGE, ipCidrRange: GKE_SERVICE_CIDR },
      ],
      // Cloud Run reaches this subnet through a connector or direct VPC egress;
      // both require Google's own access to the range.
      privateIpGoogleAccess: true,
    })

    /*
     * Where the Cloud Run services get their addresses, and the only subnet a
     * rule below names as a source. Nothing that can take an instance is placed
     * here — see `CLOUDRUN_EGRESS_CIDR` for why that is the point rather than a
     * detail. `privateIpGoogleAccess` for the same reason the workload subnet
     * has it: direct VPC egress requires Google's own access to the range.
     */
    const cloudRunEgress = new gcp.compute.Subnetwork('CloudRunEgressSubnetwork', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'cloudrun-egress' }),
      project,
      region,
      network: network.id,
      ipCidrRange: CLOUDRUN_EGRESS_CIDR,
      privateIpGoogleAccess: true,
    })

    const managedProxy = new gcp.compute.Subnetwork('ManagedProxySubnetwork', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'managed-proxy' }),
      project,
      region,
      network: network.id,
      ipCidrRange: MANAGED_PROXY_CIDR,
      // `ACTIVE` is the one that serves. A subnet reserved this way takes no
      // instance and no placement; see the note on `MANAGED_PROXY_CIDR`.
      purpose: 'REGIONAL_MANAGED_PROXY',
      role: 'ACTIVE',
    })

    /*
     * Outbound internet for workloads with no address of their own.
     *
     * A router and a NAT rather than a NAT instance: Google has no equivalent
     * of the cheap EC2 NAT the AWS side runs, and Cloud NAT is the managed
     * answer. `internetEgress: false` builds neither, which is a stage whose
     * workloads cannot pull an image — supported, and named rather than assumed.
     */
    const router = request.internetEgress
      ? new gcp.compute.Router('Router', {
          name: instanceFor({ app: $app.name, stage: $app.stage }),
          project,
          region,
          network: network.id,
        })
      : null
    const nat = router
      ? new gcp.compute.RouterNat('Nat', {
          name: instanceFor({ app: $app.name, stage: $app.stage }),
          project,
          region,
          router: router.name,
          natIpAllocateOption: 'AUTO_ONLY',
          sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
          logConfig: { enable: true, filter: 'ERRORS_ONLY' },
        })
      : null

    /*
     * The peering that lets a managed database take a private address.
     *
     * Two resources for one idea: a range reserved out of this network, and the
     * connection that hands it to Google's service producer. Both, and in this
     * order, or Cloud SQL refuses a private IP with an error about the service.
     */
    const serviceRange = new gcp.compute.GlobalAddress('PrivateServiceRange', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'psa' }),
      project,
      purpose: 'VPC_PEERING',
      addressType: 'INTERNAL',
      prefixLength: SERVICE_RANGE_PREFIX,
      network: network.id,
    })
    const privateServiceAccess = new gcp.servicenetworking.Connection('PrivateServiceAccess', {
      network: network.id,
      service: 'servicenetworking.googleapis.com',
      reservedPeeringRanges: [serviceRange.name],
    })

    const accounts = Object.fromEntries(
      Object.entries(ACCOUNTS).map(([role, resource]) => [
        role,
        new gcp.serviceaccount.Account(resource, {
          project,
          accountId: identityFor({ appShort, stage: $app.stage, artifact: role, action: 'run' }),
          displayName: `BoxLite ${role} (${$app.stage})`,
        }),
      ]),
    ) as Record<WorkloadRole, CloudResource>

    /*
     * Service to service, keyed on identity rather than on a range.
     *
     * `sourceServiceAccounts` is the property that makes this the mirror of the
     * AWS security-group pair: a workload is admitted because of who it is, not
     * because of where it sits. A rule keyed on the subnet range would also
     * admit anything else that ever lands in it.
     *
     * Identity selects instances, and that bounds this rule to less than it
     * reads as — the hole the file header describes, restated where a reader
     * meets it. None of the three roles named on either end runs an instance
     * under its account: the API and the collector are Cloud Run services, and
     * the proxy's account is bound to its Pods through Workload Identity while
     * their packets leave a node running under the cluster's own. Every path
     * those three actually take is keyed elsewhere — `RunnerFirewall` below,
     * the Pod range in `edge.ts`, `clickhouse.ts` for the telemetry host — so
     * none of them is what the 504 was, and none of them crosses here.
     */
    const serviceIdentities = [accounts.api, accounts.proxy, accounts['otel-collector']].map((account) => account.email)
    const internal = new gcp.compute.Firewall('InternalFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'internal' }),
      project,
      network: network.id,
      direction: 'INGRESS',
      priority: 1000,
      allows: [{ protocol: 'tcp', ports: INTERNAL_PORTS }],
      sourceServiceAccounts: serviceIdentities,
      targetServiceAccounts: serviceIdentities,
    })

    /*
     * The runner answers the API here. GKE Pod addresses are admitted by the
     * proxy edge beside the cluster that owns their secondary range.
     *
     * A range on the source side, and this is the one rule in the file that
     * cannot name its caller by identity. The API is a Cloud Run service
     * reaching a VM, and `sourceServiceAccounts` does not match direct-egress
     * traffic at all — the rule admits nothing, the deny at 65534 swallows the
     * SYN, and `/v1/boxes/*` returns 504 after a full connect timeout while the
     * runner sits healthy and logs nothing.
     *
     * A source tag is the trap that looks like the fix, and this rule carried
     * one: Google lists tags and identity together among the sources direct VPC
     * egress does not support on an ingress rule. `CLOUDRUN_EGRESS_CIDR` has the
     * measurement — identity 504s after a 127-second connect timeout, the range
     * serves in half a second. So the source is the range those packets leave
     * from, which that subnet keeps as narrow as the caller. The target is an
     * account again — only a source *tag* cannot be paired with one.
     */
    const runnerIngress = new gcp.compute.Firewall('RunnerFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runner' }),
      project,
      network: network.id,
      direction: 'INGRESS',
      priority: 1000,
      allows: [{ protocol: 'tcp', ports: [String(RUNNER_PORT)] }],
      sourceRanges: [CLOUDRUN_EGRESS_CIDR],
      targetServiceAccounts: [accounts.runner.email],
    })

    /*
     * The one way into a live runner, opened for one job.
     *
     * A host's binary is replaced in place — `stack/runner-upgrade.ts` says why
     * it has to be — and this cloud has no SSM to do it over, so the deploy
     * reaches the host through IAP's TCP tunnel instead. IAP proxies from a
     * fixed Google-owned range, so the source is that range rather than
     * anything of ours; a narrower one does not exist, and a wider one would be
     * a real inbound port on a host that runs untrusted code by design.
     *
     * Keyed on the runner's own identity and port 22 alone. It is not a way in
     * for a person: reaching the tunnel needs `roles/iap.tunnelResourceAccessor`
     * on the project, which `bootstrap/gcp.ts` grants the deployer and nothing
     * else.
     */
    const runnerIap = new gcp.compute.Firewall('RunnerIapFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runner-iap' }),
      project,
      network: network.id,
      direction: 'INGRESS',
      priority: 1000,
      allows: [{ protocol: 'tcp', ports: ['22'] }],
      sourceRanges: ['35.235.240.0/20'],
      targetServiceAccounts: [accounts.runner.email],
    })

    // And the other direction: a runner registers itself and ships telemetry.
    // The source is an instance and matches; the targets are the two Cloud Run
    // services, which no VPC rule reaches — see `InternalFirewall` above.
    const runnerEgress = new gcp.compute.Firewall('RunnerToServicesFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runner-to-services' }),
      project,
      network: network.id,
      direction: 'INGRESS',
      priority: 1000,
      allows: [{ protocol: 'tcp', ports: [String(API_PORT), String(OTLP_HTTP_PORT)] }],
      sourceServiceAccounts: [accounts.runner.email],
      targetServiceAccounts: [accounts.api.email, accounts['otel-collector'].email],
    })

    /*
     * Deny everything else inbound.
     *
     * Google's implied rules already deny ingress, but only at the lowest
     * priority — a rule someone adds later at a higher one silently wins. An
     * explicit deny at 65534 makes any such rule a visible edit to this file's
     * neighbourhood rather than an invisible widening.
     */
    const denied = new gcp.compute.Firewall('DenyIngressFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'deny-ingress' }),
      project,
      network: network.id,
      direction: 'INGRESS',
      priority: 65534,
      denies: [{ protocol: 'all' }],
      sourceRanges: ['0.0.0.0/0'],
    })

    const placementFor = (role: WorkloadRole): Placement => ({
      cloud: 'gcp',
      /*
       * Private, every role, including the runner.
       *
       * On AWS the runner is `egress-only-public` so its constant image pulls
       * do not queue behind a shared NAT. Here they must: an organization with
       * `constraints/compute.vmExternalIpAccess` refuses an instance that asks
       * for an external address, and every workload's outbound goes through
       * Cloud NAT instead. Saying `private` is what makes that visible at the
       * placement rather than surprising at the instance.
       */
      exposure: 'private',
      subnetwork: subnetwork.id,
      // Offered to every role and read only by the two that are Cloud Run
      // services. Separate from `subnetwork` because that one also places the
      // API's internal address, which belongs beside its clients rather than in
      // the range a firewall rule names as a source.
      egressSubnetwork: cloudRunEgress.id,
      serviceAccount: accounts[role].email,
    })

    return {
      binding: {
        cloud: 'gcp',
        network: network.selfLink,
        subnetwork: subnetwork.selfLink,
        privateServiceAccess: privateServiceAccess.id,
        cidr: subnetwork.ipCidrRange,
      },
      placementFor,
      ready: [
        privateServiceAccess,
        cloudRunEgress,
        managedProxy,
        internal,
        runnerIngress,
        runnerIap,
        runnerEgress,
        denied,
        ...(nat ? [nat] : []),
      ],
    }
  }
