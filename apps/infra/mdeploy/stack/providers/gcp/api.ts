/*
 * The control plane as a Cloud Run service, behind two load balancers.
 *
 * A global one for the internet and a regional internal one for this network,
 * both in front of the same service and both answering `api.<domain>`. The
 * second exists because the first is the only way in that ever existed, and a
 * runner sitting one subnet away was taking it — out through Cloud NAT to an
 * anycast address and back. The note above `ApiInternalEndpointGroup` says how
 * the name comes to mean two different addresses depending on who asks.
 *
 * The load balancer is what makes the two front doors of the AWS side one door
 * here. There, a CDN serves the dashboard's assets at the root domain and a
 * second balancer answers `api.<domain>`, because CloudFront caps a WebSocket
 * at ten minutes. Google's global load balancer has no such cap and its CDN is
 * a flag on the same backend, so one balancer answers both names.
 *
 * One balancer, still two names. `api.<domain>` is not decoration: it is what
 * `DASHBOARD_BASE_API_URL` defaults to, what the SDKs are configured with, and
 * what `address` means on the other cloud. Serving only the root domain here
 * would leave every one of those pointed at a hostname nothing answers — a
 * stack that deploys green and cannot be called. So the certificate covers both
 * and both are written into DNS, and `url` and `address` keep saying the same
 * two things they say on AWS.
 *
 * Capabilities become IAM bindings rather than policy documents, and they are
 * attached at the *resource* rather than at the principal. That is the shape of
 * Google's IAM and not a choice: there is nothing to hand a service account.
 * The one that needs care is the volume-bucket grant — Google has no wildcard
 * over resource names, so the role is granted at the project with a CEL
 * condition that puts the prefix back. Without that condition the API could
 * delete any bucket in the project, which is why `storage.ts` carries the
 * condition rather than leaving it to be written here.
 */

import type { Api, ApiCapability, ApiDependencies, ApiProvider, ApiRequest } from '../../api.ts'
import { basename, dirname } from 'node:path'
import { CACHE_CA_PATH, CACHE_PASSWORD_VARIABLE, type CacheBinding } from '../../cache.ts'
import { CLICKHOUSE_PASSWORD_VARIABLE } from '../../clickhouse.ts'
import { DATABASE_PASSWORD_VARIABLE, type DatabaseBinding } from '../../database.ts'
import type { Placement } from '../../network.ts'
import type { StorageBinding } from '../../storage.ts'
import { containerEnvironment, secretIdOf } from './secret-env.ts'
import { VOLUME_OBJECT_ACCESS_ROLE } from './storage.ts'
import { instanceFor } from 'naming'
import { certificateNameFor } from './certificate-name.ts'

const onGcp = (storage: { binding: StorageBinding }): Extract<StorageBinding, { cloud: 'gcp' }> => {
  if (storage.binding.cloud !== 'gcp') throw new Error(`The GCP API was handed ${storage.binding.cloud} storage`)
  return storage.binding
}

/**
 * The one name Cloud Run accepts for a Cloud SQL volume, and the directory it
 * appears under. Reserved by the platform: anything else is refused with
 * `Cloud SQL volume must be named 'cloudsql'`.
 */
const CLOUD_SQL_VOLUME = 'cloudsql'

/** The cache's CA: the volume that carries it, and the file inside it. */
const CACHE_CA_VOLUME = 'cache-ca'
const CACHE_CA_FILE = basename(CACHE_CA_PATH)

const onGcpCache = (cache: { binding: CacheBinding }): Extract<CacheBinding, { cloud: 'gcp' }> => {
  if (cache.binding.cloud !== 'gcp') throw new Error(`The GCP API was handed a ${cache.binding.cloud} cache`)
  return cache.binding
}

const onGcpDatabase = (database: { binding: DatabaseBinding }): Extract<DatabaseBinding, { cloud: 'gcp' }> => {
  if (database.binding.cloud !== 'gcp') throw new Error(`The GCP API was handed a ${database.binding.cloud} database`)
  return database.binding
}

/** One capability, as the bindings it becomes. Each returns its own resources. */
const bindingsFor = ({
  capability,
  index,
  project,
  member,
  bucketName,
}: {
  capability: ApiCapability
  index: number
  project: string
  member: $util.Output<string>
  bucketName: $util.Output<string>
}): any[] => {
  const principal = member.apply((email: string) => `serviceAccount:${email}`)
  switch (capability.kind) {
    case 'list-own-bucket':
      // On the bucket itself, which needs no condition: it already names
      // exactly one resource.
      return [
        new gcp.storage.BucketIAMMember(`ApiCapability${index}`, {
          bucket: bucketName,
          role: onGcp(capability.storage).listGrant,
          member: principal,
        }),
      ]
    case 'manage-volume-buckets': {
      const storage = onGcp(capability.storage)
      return [
        new gcp.projects.IAMMember(`ApiCapability${index}`, {
          project,
          role: storage.lifecycleGrant,
          member: principal,
          // The prefix, as this cloud is able to express it. See the note above.
          condition: storage.volumeCondition,
        }),
      ]
    }
    case 'vend-volume-credentials':
      // Google's equivalent of assuming a role: the API mints a short-lived
      // token for the vending account and scopes it to one organization.
      return [
        new gcp.serviceaccount.IAMMember(`ApiCapability${index}`, {
          serviceAccountId: onGcp(capability.storage).credentialVending.serviceAccount.apply(
            (email: string) => `projects/${project}/serviceAccounts/${email}`,
          ),
          role: 'roles/iam.serviceAccountTokenCreator',
          member: principal,
        }),
      ]
    case 'read-telemetry':
      // The reader password reaches the container by reference, so the account
      // has to be allowed to resolve that reference. Named per secret rather
      // than granted at the project: nothing else in Secret Manager.
      return capability.clickhouse.active
        ? [
            new gcp.secretmanager.SecretIamMember(`ApiCapability${index}`, {
              project,
              secretId: capability.clickhouse.reader.passwordRef.apply((reference: string) =>
                secretIdOf(reference),
              ),
              role: 'roles/secretmanager.secretAccessor',
              member: principal,
            }),
          ]
        : []
    case 'read-secret':
      return [
        new gcp.secretmanager.SecretIamMember(`ApiCapability${index}`, {
          project,
          secretId: capability.ref.apply((reference: string) => secretIdOf(reference)),
          role: 'roles/secretmanager.secretAccessor',
          member: principal,
        }),
      ]
  }
}

export const gcpApiProvider =
  ({
    dependencies,
    project,
    region,
    domain,
    callers,
    zoneId,
    network,
    runnerAccount,
  }: {
    dependencies: ApiDependencies
    project: string
    region: string
    /** The hostname the dashboard and the SDKs reach it on. */
    domain: string
    /** The identities allowed to invoke it. The proxy and the runner. */
    callers: $util.Output<string>[]
    /** The Cloudflare zone the record is written into. */
    zoneId: string
    /**
     * The network itself, for the two resources below that name one: the
     * internal balancer's forwarding rule and the runner's egress rule. A
     * placement carries only a subnetwork, and neither is derivable from the
     * other by string surgery — the same reason `edge.ts` is handed it.
     */
    network: $util.Output<string>
    /** The runner's identity, which the egress rule below is keyed on. */
    runnerAccount: $util.Output<string>
  }): ApiProvider =>
  (request: ApiRequest): Api => {
    const placement = dependencies.placement as Extract<Placement, { cloud: 'gcp' }>
    const storage = onGcp(dependencies.storage)
    /*
     * The hostname the control plane is called on, composed the same way the
     * AWS provider composes it. Derived rather than taken as a second setting:
     * `api-environment.ts` derives `DASHBOARD_BASE_API_URL` from the stack
     * domain by exactly this rule, and two places deriving it is two places
     * they can disagree — which is a dashboard calling a name the balancer does
     * not serve, with nothing failing at deploy time to say so.
     */
    const apiHost = `api.${domain}`

    /*
     * Every name this container is handed by reference, in one place.
     *
     * One list, because the grants below are derived from it. They used not to
     * be: the capability list granted what a capability named, and these three
     * were added straight into the container's environment beside it — so the
     * two passwords the stack itself mints were delivered to a service account
     * that had never been allowed to read them. Cloud Run does not start such a
     * revision and does not fail quietly either; it refuses the create with
     * `Permission denied on secret: …-cache-password`, ninety seconds in.
     */
    const addresses: Record<string, $util.Input<string>> = {
      ...request.secrets,
      [DATABASE_PASSWORD_VARIABLE]: dependencies.database.binding.passwordRef,
      [CACHE_PASSWORD_VARIABLE]: dependencies.cache.binding.passwordRef,
      ...(dependencies.clickhouse.active
        ? { [CLICKHOUSE_PASSWORD_VARIABLE]: dependencies.clickhouse.reader.passwordRef }
        : {}),
    }

    /*
     * Read access to every secret this container is handed, by either channel.
     *
     * `addresses` is what arrives as an environment reference; the cache's CA
     * arrives as a *mounted file*, and Cloud Run resolves that one just as
     * strictly — `Permission denied on secret: …-cache-ca` refuses the revision
     * exactly as a missing env grant does. Deriving the grants from the env
     * list alone was the first version of this and it missed the mount, which
     * is the same defect twice: one list of what is handed over, and the grants
     * follow from it.
     */
    const handedOver: Record<string, $util.Input<string>> = {
      ...addresses,
      [CACHE_CA_VOLUME]: onGcpCache(dependencies.cache).caRef,
    }
    const readable = Object.keys(handedOver).map(
      (name) =>
        new gcp.secretmanager.SecretIamMember(`ApiSecretAccess-${name}`, {
          project,
          secretId: $util.output(handedOver[name] as $util.Input<string>).apply((reference: string) =>
            secretIdOf(reference),
          ),
          role: 'roles/secretmanager.secretAccessor',
          member: placement.serviceAccount.apply((email: string) => `serviceAccount:${email}`),
        }),
    )

    const service = new gcp.cloudrunv2.Service(
      'Api',
      {
        name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api' }),
        project,
        location: region,
        /*
         * The ingress *is* the restriction. Read the note on `publicInvoker`
         * below before widening this: the two are one decision, and a value
         * here that admits the internet turns that binding into a public API.
         */
        ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
        // A rename is a delete and a create, and the provider defaults this on
        // and reads the value held in state — so it refuses the delete half.
        // Left on, the first rename of this service costs two applies.
        deletionProtection: false,
        template: {
          serviceAccount: placement.serviceAccount,
          /*
           * The Cloud SQL proxy the platform builds in, as a volume.
           *
           * `cloudsql` is the only name Cloud Run takes for it — *"Cloud SQL
           * volume must be named 'cloudsql'"* — and the mount path is the same
           * word. Mounting is not by itself a route: the proxy's traffic rides
           * this service's own VPC egress and the instance needs
           * `enablePrivatePathForGoogleCloudServices`, or the socket is present
           * and accepts nothing. Both are set; `database.ts` carries the flag.
           */
          volumes: [
            {
              name: CLOUD_SQL_VOLUME,
              cloudSqlInstance: { instances: [onGcpDatabase(dependencies.database).connectionName] },
            },
            /*
             * The cache's CA, as a file rather than a value.
             *
             * Memorystore signs with a certificate no image trusts and has no
             * platform proxy to hide behind, so the certificate has to reach
             * the container. `apps/api` builds its Redis TLS options as a bare
             * `tls: {}` and has nowhere to put a CA — but Node reads
             * `NODE_EXTRA_CA_CERTS` and adds what it finds to the default
             * store, so a mounted file solves it without an application change.
             */
            {
              name: CACHE_CA_VOLUME,
              secret: {
                secret: onGcpCache(dependencies.cache).caRef.apply((reference: string) => secretIdOf(reference)),
                items: [{ version: 'latest', path: CACHE_CA_FILE }],
              },
            },
          ],
          /*
           * An hour, matching `apps/api`'s own keep-alive and the AWS load
           * balancer's idle timeout: an exec attach that idles through a pause
           * must not be closed under it. This is the only place a Cloud Run
           * request deadline can be set — the balancer in front refuses to hold
           * one — and the default is five minutes.
           */
          timeout: '3600s',
          vpcAccess: { egress: 'PRIVATE_RANGES_ONLY', networkInterfaces: [{ subnetwork: placement.subnetwork }] },
          containers: [
            {
              image: request.image,
              ports: [{ name: 'http1', containerPort: request.port }],
              volumeMounts: [
                { name: CLOUD_SQL_VOLUME, mountPath: `/${CLOUD_SQL_VOLUME}` },
                { name: CACHE_CA_VOLUME, mountPath: dirname(CACHE_CA_PATH) },
              ],
              startupProbe: { httpGet: { path: '/api/health', port: request.port }, failureThreshold: 30 },
              livenessProbe: { httpGet: { path: '/api/health', port: request.port } },
              envs: containerEnvironment({ values: request.environment, addresses }),
            },
          ],
        },
      },
      {
        /*
         * The grants above among them. Cloud Run resolves every `secretKeyRef`
         * while creating the revision, so a binding that lands a moment later is
         * a binding that lands after the refusal.
         */
        dependsOn: [...dependencies.waitFor, ...readable],
      },
    )

    const invokers = callers.map(
      (member, index) =>
        new gcp.cloudrunv2.ServiceIamMember(`ApiInvoker${index}`, {
          project,
          location: region,
          name: service.name,
          role: 'roles/run.invoker',
          member: member.apply((email: string) => `serviceAccount:${email}`),
        }),
    )

    /*
     * The one grant that looks wrong and is not, so it says why here.
     *
     * Cloud Run checks IAM on *every* request, and a load balancer carries no
     * identity token — there is nothing in a serverless NEG that signs as
     * anybody. Named invokers therefore authorise the proxy and the runner when
     * they call the service directly, and authorise nothing at all for the path
     * every browser and SDK actually takes: through the load balancer, which
     * arrives unauthenticated and is refused 403.
     *
     * So the invoker is `allUsers` and the *ingress* above is the whole
     * restriction. That is not a loosening of the AWS model, it is the port of
     * it: there the API sat behind a security group with no per-request
     * authorization either, and reachability was the boundary. It is written as
     * one pair on purpose — widening `ingress` beside this line is a one-word
     * edit that publishes the control plane to the internet.
     */
    const publicInvoker = new gcp.cloudrunv2.ServiceIamMember('ApiLoadBalancerInvoker', {
      project,
      location: region,
      name: service.name,
      role: 'roles/run.invoker',
      member: 'allUsers',
    })

    /*
     * What a vended token may do inside one volume bucket.
     *
     * The mirror of the AWS side's `S3AccessRolePolicy`: this is the ceiling,
     * and the per-organization condition the API attaches when it mints a token
     * narrows it further. Effective access is the intersection.
     */
    const vendingCeiling = new gcp.projects.IAMMember('VolumeAccessCeiling', {
      project,
      role: VOLUME_OBJECT_ACCESS_ROLE,
      member: storage.credentialVending.serviceAccount.apply((email: string) => `serviceAccount:${email}`),
      condition: storage.volumeCondition,
    })

    const granted = request.capabilities.flatMap((capability, index) =>
      bindingsFor({ capability, index, project, member: placement.serviceAccount, bucketName: dependencies.storage.name }),
    )

    /*
     * The global load balancer: a serverless network endpoint group pointing at
     * the service, a backend, a URL map, a managed certificate and a forwarding
     * rule. Five resources for what an ALB does in one, which is simply how
     * this cloud spells it.
     */
    const endpointGroup = new gcp.compute.RegionNetworkEndpointGroup('ApiEndpointGroup', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-neg' }),
      project,
      region,
      networkEndpointType: 'SERVERLESS',
      cloudRun: { service: service.name },
    })
    const backend = new gcp.compute.BackendService('ApiBackend', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api' }),
      project,
      loadBalancingScheme: 'EXTERNAL_MANAGED',
      protocol: 'HTTPS',
      backends: [{ group: endpointGroup.id }],
      /*
       * No `timeoutSec`. A backend service fronting a serverless network
       * endpoint group refuses one outright — *"Timeout sec is not supported for
       * a backend service with Serverless network endpoint groups"* — because
       * the request deadline for a Cloud Run backend is Cloud Run's own. It is
       * set on the service's template above, and the AWS side's hour lives
       * there rather than being quietly lost here.
       */
    })
    const urlMap = new gcp.compute.URLMap('ApiUrlMap', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api' }),
      project,
      defaultService: backend.id,
    })
    /*
     * The name carries the domains, and the replacement is a create first.
     *
     * A managed certificate's domains are immutable, so changing one replaces
     * the certificate — and this provider deletes before it creates. The target
     * proxy below still references the old one at that moment, so the delete is
     * refused and the stage is left with a certificate it cannot remove and a
     * replacement it cannot create. Naming it after its domains lets both exist
     * at once, and `deleteBeforeReplace: false` is what puts the delete last.
     */
    const certificate = new gcp.compute.ManagedSslCertificate(
      'ApiCertificate',
      {
        name: certificateNameFor({ domain, base: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api' }) }),
        project,
        // Both names this balancer answers on. A certificate covering only one of
        // them fails the handshake for the other, which is the half every SDK uses.
        managed: { domains: [domain, apiHost] },
      },
      { deleteBeforeReplace: false },
    )
    const proxy = new gcp.compute.TargetHttpsProxy('ApiHttpsProxy', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api' }),
      project,
      urlMap: urlMap.id,
      sslCertificates: [certificate.id],
    })
    const address = new gcp.compute.GlobalAddress('ApiAddress', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api' }),
      project,
    })
    const forwarding = new gcp.compute.GlobalForwardingRule('ApiForwardingRule', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api' }),
      project,
      target: proxy.id,
      portRange: '443',
      ipAddress: address.address,
      loadBalancingScheme: 'EXTERNAL_MANAGED',
    })

    /*
     * The two DNS records, written into Cloudflare rather than Cloud DNS.
     *
     * The zone is not Google's on either cloud, which is the one part of the
     * front door that did not have to be replaced. Proxying is off: Google's
     * managed certificate is validated by reaching this address directly, and a
     * proxied record answers from Cloudflare instead — so the certificate would
     * never leave `PROVISIONING`. Both names need a record for the same reason:
     * a managed certificate provisions per domain, and one that does not resolve
     * to this balancer holds the whole certificate in `FAILED_NOT_VISIBLE`.
     */
    const record = new cloudflare.Record('ApiRecord', {
      zoneId,
      name: domain,
      type: 'A',
      content: address.address,
      proxied: false,
      ttl: 60,
    })
    const apiRecord = new cloudflare.Record('ApiHostRecord', {
      zoneId,
      name: apiHost,
      type: 'A',
      content: address.address,
      proxied: false,
      ttl: 60,
    })

    /*
     * The same control plane, reached without leaving the network.
     *
     * Everything above is the public front door: a global balancer on an
     * anycast address, and two Cloudflare records pointing at it. A runner is a
     * VM in this VPC with no address of its own, so `api.<domain>` sends its
     * registration and every poll out through Cloud NAT to that public address
     * and back in — for two workloads a subnet apart.
     *
     * A regional internal balancer in front of the same service, and a private
     * zone that answers for `api.<domain>` inside this network alone, keeps the
     * call on the wire it never had to leave. The hostname does not change, and
     * that is the whole reason it is built this way rather than by handing the
     * runner Cloud Run's own `run.app` address: `BOXLITE_API_URL` is written
     * into a host's systemd unit at first boot and `runner-update.ts` replaces
     * only the binary, so a name this stack does not own becomes a name no
     * existing host can be told about. Keeping the name means every host —
     * including one created before any of this existed — resolves it to the
     * address below the moment the zone is there.
     */
    const internalEndpointGroup = new gcp.compute.RegionNetworkEndpointGroup('ApiInternalEndpointGroup', {
      // Its own group rather than the public balancer's. A serverless group
      // costs nothing, and one shared between an `EXTERNAL_MANAGED` and an
      // `INTERNAL_MANAGED` backend ties the internal path's lifecycle to the
      // public one's for no gain.
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal-neg' }),
      project,
      region,
      networkEndpointType: 'SERVERLESS',
      cloudRun: { service: service.name },
    })
    const internalBackend = new gcp.compute.RegionBackendService('ApiInternalBackend', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
      project,
      region,
      loadBalancingScheme: 'INTERNAL_MANAGED',
      protocol: 'HTTPS',
      backends: [{ group: internalEndpointGroup.id }],
      // No `timeoutSec`, for the reason the public backend gives above: a
      // serverless group's request deadline is Cloud Run's own.
    })
    const internalUrlMap = new gcp.compute.RegionUrlMap('ApiInternalUrlMap', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
      project,
      region,
      defaultService: internalBackend.id,
    })

    /*
     * A certificate for the same name, issued a second time and a different way.
     *
     * The `ManagedSslCertificate` above is a global resource and a regional
     * target proxy will not take one, so this path needs its own — and
     * Certificate Manager is the only issuer with a regional form. It proves
     * the domain through DNS rather than by being reached, which is what makes
     * it possible at all: nothing on the internet can reach this balancer, so
     * the reachability check the public certificate passes could never pass
     * here.
     *
     * The challenge record is published first. A certificate that starts
     * proving before the record exists does not fail, it waits out Google's
     * retry — which is a deploy that sits in `PROVISIONING` for no reason
     * anybody watching it can see.
     */
    const internalAuthorization = new gcp.certificatemanager.DnsAuthorization('ApiInternalDnsAuthorization', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
      project,
      location: region,
      domain: apiHost,
    })
    const internalChallenge = new cloudflare.Record('ApiInternalDnsAuthorizationRecord', {
      zoneId,
      name: internalAuthorization.dnsResourceRecords[0].name,
      type: internalAuthorization.dnsResourceRecords[0].type,
      content: internalAuthorization.dnsResourceRecords[0].data,
      proxied: false,
      ttl: 60,
    })
    // The name carries the domain and the delete comes last, for the reason
    // `certificate-name.ts` gives for the two certificates that already do it.
    const internalCertificate = new gcp.certificatemanager.Certificate(
      'ApiInternalCertificate',
      {
        name: certificateNameFor({
          domain: apiHost,
          base: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
        }),
        project,
        location: region,
        managed: { domains: [apiHost], dnsAuthorizations: [internalAuthorization.id] },
      },
      { deleteBeforeReplace: false, dependsOn: [internalChallenge] },
    )
    const internalProxy = new gcp.compute.RegionTargetHttpsProxy('ApiInternalHttpsProxy', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
      project,
      region,
      urlMap: internalUrlMap.id,
      // A Certificate Manager certificate attaches by resource path, where the
      // load balancer's own kind attaches by id under `sslCertificates`. A
      // regional proxy takes one spelling or the other and refuses both.
      certificateManagerCertificates: [
        internalCertificate.id.apply((id: string) => `//certificatemanager.googleapis.com/${id}`),
      ],
    })
    /*
     * The address, out of the one subnet this network has — which is also where
     * every client of it sits. Reserved rather than left ephemeral for the same
     * reason the public one is: it is what a DNS record points at.
     */
    const internalAddress = new gcp.compute.Address('ApiInternalAddress', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
      project,
      region,
      addressType: 'INTERNAL',
      subnetwork: placement.subnetwork,
    })
    const internalForwarding = new gcp.compute.ForwardingRule('ApiInternalForwardingRule', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
      project,
      region,
      target: internalProxy.id,
      portRange: '443',
      ipAddress: internalAddress.address,
      loadBalancingScheme: 'INTERNAL_MANAGED',
      // The Envoys this rule runs on live in the network's `REGIONAL_MANAGED_PROXY`
      // subnet, which `network.ts` owns and every workload already waits on.
      network,
      subnetwork: placement.subnetwork,
    })

    /*
     * The private zone: the half that changes nothing and decides everything.
     *
     * `api.<domain>` keeps answering publicly — the Cloudflare record above is
     * untouched, and the dashboard and every SDK still reach the global
     * balancer. This zone is visible to this network and nowhere else, and
     * inside it the same name resolves to the internal address instead. A VM
     * resolves through the metadata server, which is authoritative for a bound
     * private zone and forwards nothing upstream, so the public record is not
     * queried at all rather than queried and overridden.
     *
     * Scoped to the one hostname rather than to `<domain>`: a zone for the
     * whole stack domain would shadow the dashboard and the box proxy in here
     * too, and neither has anything internal to be pointed at.
     */
    const internalZone = new gcp.dns.ManagedZone('ApiInternalZone', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'api-internal' }),
      project,
      dnsName: `${apiHost}.`,
      description: `${apiHost}, as reached from inside the network`,
      visibility: 'private',
      privateVisibilityConfig: { networks: [{ networkUrl: network }] },
    })
    const internalRecord = new gcp.dns.RecordSet('ApiInternalRecord', {
      project,
      managedZone: internalZone.name,
      name: `${apiHost}.`,
      type: 'A',
      ttl: 60,
      rrdatas: [internalAddress.address],
    })

    /*
     * And the fence: with the name resolving internally, the public address is
     * no longer a path a runner may take.
     *
     * Without this the internal route is a default rather than a guarantee.
     * Anything on the host that resolves through something other than the
     * metadata server — a container handed its own `--dns`, an address written
     * down somewhere — goes straight back out through Cloud NAT to the public
     * balancer, works perfectly, and says nothing. Denying the one destination
     * turns that into a refused connection at the host instead of a silent
     * hairpin through the internet.
     *
     * Scoped to this address alone, and not to the internet: a runner still
     * pulls images and downloads its own binary over that NAT, so a wider deny
     * is a host that cannot boot. And it is ordered after the internal path is
     * serving, or an update lands the fence while the only route still open is
     * the one it closes.
     *
     * It lives here rather than beside the runner's other rules in `network.ts`
     * because the address it names is created here — the same reason `edge.ts`
     * owns the rule that admits the balancer to the proxy hosts.
     */
    const runnerPublicDeny = new gcp.compute.Firewall(
      'RunnerDenyPublicApiFirewall',
      {
        name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'runner-deny-public-api' }),
        project,
        network,
        direction: 'EGRESS',
        priority: 1000,
        denies: [{ protocol: 'tcp', ports: ['443'] }],
        destinationRanges: [address.address.apply((ip: string) => `${ip}/32`)],
        targetServiceAccounts: [runnerAccount],
      },
      { dependsOn: [internalForwarding, internalRecord] },
    )

    return {
      // The same two things they mean on AWS: where the dashboard is served
      // from, and where the control plane is called.
      url: $util.output(`https://${domain}`),
      address: $util.output(`https://${apiHost}`),
      identity: placement.serviceAccount,
      // A log-based metric filters on the service's own name, which is what
      // this cloud's monitoring knows it by.
      metricTarget: service.name,
      ready: [
        service,
        ...invokers,
        publicInvoker,
        ...readable,
        ...granted,
        vendingCeiling,
        forwarding,
        record,
        apiRecord,
        // The internal path, which a runner created by this same deploy has to
        // find already serving: it registers itself at first boot.
        internalForwarding,
        internalRecord,
        runnerPublicDeny,
      ],
    }
  }
