/*
 * The box proxy on GCP: a terminating load balancer in front of container hosts.
 *
 * This used to be a layer-4 passthrough, justified by the proxy needing to read
 * the SNI name itself. That justification was wrong about both ends.
 *
 * The proxy does not read SNI. It routes on the HTTP Host header —
 * `parseHost(ctx.Request.Host)` in `apps/proxy/pkg/proxy/get_box_target.go` —
 * and a Host header survives termination. Nor does the AWS side pass TLS
 * through: `providers/aws/edge.ts` declares `listen: '443/tls'`, which is an
 * NLB listener that terminates, with an ACM certificate for `<domain>` and
 * `*.<domain>` on the balancer. The task behind it receives plaintext on 4000,
 * and `ENABLE_TLS` is unset on both clouds, so the container never serves TLS
 * at all.
 *
 * Passing through therefore did not port the AWS design; it broke it. The
 * proxy serves a certificate from `TLS_CERT_FILE`/`TLS_KEY_FILE`
 * (`pkg/proxy/proxy.go`) and there is no ACME client anywhere in `apps/proxy`,
 * so nothing would have placed one — every hostname under `*.<domain>` would
 * have failed its handshake.
 *
 * So the balancer terminates here as it does there, and the wildcard
 * certificate is the deploy's job on both clouds. What GCP spells differently
 * is the certificate: a Google-managed wildcard exists only through Certificate
 * Manager with DNS authorization, which is four resources where ACM is one.
 *
 * The asymmetry that remains is real and unrelated: Cloud Run cannot be a
 * backend of this balancer, so the proxy runs on a managed instance group of
 * container-optimised VMs and costs a machine per zone the AWS side does not.
 *
 * THE CLIENT'S ADDRESS, decided rather than inherited. A proxy balancer opens
 * its own connection, so `ginCtx.ClientIP()` — used once, to set
 * `X-Forwarded-For` in `pkg/proxy/auth_callback.go` — sees the balancer. That
 * is parity, not a regression: the AWS side terminates at a `443/tls` NLB
 * listener with `ip` targets, a combination that does not preserve the client
 * address either. `proxyHeader: 'PROXY_V1'` would carry it, and is deliberately
 * not set — Gin does not parse PROXY protocol, so it would corrupt the first
 * bytes of every request rather than reveal an address. If that header is ever
 * required to carry the real client, it needs a change in `apps/proxy` first.
 */

import type { Edge, EdgeProvider, EdgeRequest } from '../../edge.ts'
import { PROXY_PORT } from '../../edge.ts'
import type { Placement } from '../../network.ts'
import { splitSecretRef } from './secret-env.ts'
import { instanceFor } from 'naming'
import { certificateNameFor } from './certificate-name.ts'

/**
 * Container-Optimized OS, which ships Docker and a credential helper for
 * Artifact Registry and nothing else worth patching.
 *
 * The alternative was a general image with a startup script that installs
 * Docker, which is the same thing done worse: slower to boot, and one more
 * thing to keep patched on a host that faces the internet.
 */
const COS_IMAGE = 'cos-cloud/cos-stable'

/** What the proxy runs on. Small: it forwards bytes, it does not compute. */
const MACHINE_TYPE = 'e2-standard-2'

/**
 * The container, started by the boot script rather than declared in metadata.
 *
 * `gce-container-declaration` was the documented contract for this image family
 * and is now refused outright — *"the option to deploy a container during VM
 * instance creation that relies on a container startup agent is discontinued"*,
 * as a 400 at template creation. So the host starts it itself, which is what
 * that notice points at for a single container.
 *
 * Two things the declaration used to do for free, and both are here on purpose:
 * `--restart always` is what `restartPolicy: Always` meant, and
 * `docker-credential-gcr configure-docker` is what lets this pull from the
 * stage's own Artifact Registry as the instance's service account.
 *
 * Every value still arrives through the env file rather than through argv or
 * metadata: a metadata value is readable by anything on the host, and argv is
 * readable in the process table. The proxy is the one host in this stack that
 * faces the internet.
 *
 * `DOCKER_CONFIG` is what makes the credential helper work at all here.
 * Container-Optimized OS mounts `/` read-only, so `configure-docker`'s default
 * destination is unwritable and it exits non-zero — `Unable to save docker
 * config: mkdir /root/.docker: read-only file system`. Under `set -e` that
 * aborts the script on its first line, so the container is never started and
 * the group reports two hosts that never became healthy with nothing in the
 * deploy having failed. `/var/lib` is writable on this image, and every docker
 * invocation below reads the same variable.
 */
const DOCKER_CONFIG = '/var/lib/docker-config'

export const startProxy = (image: string, registryHost: string): string =>
  [
    `export DOCKER_CONFIG=${DOCKER_CONFIG}`,
    `mkdir -p ${DOCKER_CONFIG}`,
    `docker-credential-gcr configure-docker --registries=${registryHost}`,
    `docker pull ${image}`,
    'docker rm -f proxy 2>/dev/null || true',
    /*
     * Host networking: the passthrough balancer forwards to the instance's own
     * address, so the container has to be listening on it rather than behind a
     * bridge with a published port.
     *
     * `--log-driver=gcplogs` is what makes this container's output readable at
     * all. COS's own agent ships journald, and docker's default `json-file`
     * driver writes to neither the journal nor Cloud Logging — so a container
     * that starts and exits leaves the group reporting an unhealthy host and
     * nothing anywhere saying why. The AWS side needs no equivalent: an ECS
     * task's log driver is the platform's own. Paired with the
     * `roles/logging.logWriter` grant below, which is what the driver
     * authenticates with.
     */
    `docker run -d --name proxy --restart always --network host --log-driver=gcplogs ` +
      `--log-opt gcp-meta-name=proxy --env-file /run/proxy.env ${image}`,
    /*
     * The host's own firewall, which is the second thing this image does not
     * share with a general Linux box.
     *
     * Container-Optimized OS boots with an `INPUT` policy that drops inbound
     * connections it was not built to expect, so a `--network host` container
     * listening on 4000 is reachable from nowhere — the packets never reach it.
     * The failure is silent in exactly the way a drop is: the balancer reports
     * `detailedHealthState: TIMEOUT` rather than a refusal or a bad status, the
     * container logs nothing because nothing arrived, and the GCP firewall rule
     * that permits the probe ranges is plainly correct. Observed on `dev2`: two
     * hosts serving `/health` locally and timing out from the balancer.
     *
     * Appended after the container starts so a host is never briefly open on a
     * port with nothing behind it, and idempotent because this script runs on
     * every boot — `-C` tests for the rule before `-A` adds it.
     */
    `iptables -w -C INPUT -p tcp --dport ${PROXY_PORT} -j ACCEPT 2>/dev/null || ` +
      `iptables -w -A INPUT -p tcp --dport ${PROXY_PORT} -j ACCEPT`,
  ].join('\n')

/**
 * The named port the balancer resolves on the instance group, and the two
 * ranges its front ends connect from.
 *
 * The ranges are Google's own for global external proxy load balancers and for
 * health checks, and they are the same two. Documented rather than guessed:
 * https://docs.cloud.google.com/load-balancing/docs/tcp/set-up-global-ext-proxy-ssl
 */
const NAMED_PORT = 'proxy'
const LOAD_BALANCER_RANGES = ['130.211.0.0/22', '35.191.0.0/16']

/** The Artifact Registry host an image address begins with, for the credential helper. */
const registryHostOf = (image: string): string => image.split('/')[0] as string

/** Where the container reads its configuration from, and nowhere else. */
export const PROXY_ENV_FILE = '/run/proxy.env'

/**
 * One `NAME=value` line of the env file, quoted so a value cannot escape it.
 *
 * Three refusals rather than one substitution, because the three failures are
 * different and only one of them is representable.
 *
 * A value that is not a plain string is an unresolved `Output`, and this is the
 * boundary that says so. Rendering one writes Pulumi's own *"Calling [toString]
 * on an [Output<T>]"* text — several lines of it — into the file, which docker
 * rejects whole (`invalid env file … contains whitespaces`, exit 125): the
 * container never starts, and the value that broke it is not named anywhere.
 * Failing here names it, at deploy time.
 *
 * A newline cannot be carried by an env file at all, so it is refused rather
 * than escaped — `--env-file` is one variable per line and there is no
 * continuation.
 *
 * A single quote is merely quoting, so it is escaped: `'` closes the literal,
 * `\'` inserts one, `'` reopens it.
 */
export const proxyEnvLine = (name: string, value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error(
      `${name} reached the proxy's env file as ${typeof value} rather than a string — an unresolved ` +
        'Output renders as Pulumi’s [toString] refusal and docker rejects the whole file; resolve it first',
    )
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} contains a newline, which an env file cannot carry — one variable is one line`)
  }
  return `printf '%s=%s\\n' ${name} '${value.replace(/'/g, `'\\''`)}' >> ${PROXY_ENV_FILE}`
}

export const gcpEdgeProvider =
  ({
    project,
    region,
    zone,
    placement,
    network,
    zoneId,
    dependsOn,
  }: {
    project: string
    region: string
    /**
     * The zone the group's hosts are created in, the same one the stage's other
     * machines use. Declared rather than spread across the region: a regional
     * group's `maxSurge` must be zero or at least its zone count, so a group
     * spanning three zones cannot express "replace one host at a time, with a
     * spare" — which is the policy every running box's connection depends on.
     */
    zone: string
    placement: Extract<Placement, { cloud: 'gcp' }>
    /**
     * The network the firewall rule attaches to, from the network's own
     * binding.
     *
     * Taken rather than derived. It used to be recovered from the subnetwork by
     * stripping `/regions/…` off it, which yields `projects/<project>` — and the
     * API reads the last segment as the network's name, so the rule was refused
     * for a network named after the project. A self link is a thing to be handed,
     * not a string to be cut down.
     */
    network: $util.Output<string>
    /** The Cloudflare zone the two records are written into. */
    zoneId: string
    dependsOn: any[]
  }): EdgeProvider =>
  (request: EdgeRequest): Edge => {
    /*
     * The whole boot: the environment file, then the container.
     *
     * Every value goes through the file — the plain ones as well as the secrets
     * — because the channel that used to carry the plain ones was the container
     * declaration, and that is metadata, which anything on this host can read.
     * One file, one `--env-file`, and nothing about the proxy's configuration
     * is visible to a process that merely runs here.
     *
     * `gcloud` is not on Container-Optimized OS, so a secret is fetched from the
     * metadata server's own token and the Secret Manager REST API. That is the
     * documented way to read one from a COS host and needs nothing installed.
     */
    /*
     * `request.environment` is resolved rather than cast.
     *
     * Its values are `Input<string>`, and at least one is a genuine unresolved
     * `Output` — the composition root sets `OTEL_EXPORTER_OTLP_ENDPOINT` from
     * the collector's URL. Spreading it under an `as Record<string, string>`
     * cast and interpolating the result writes Pulumi's own
     * *"Calling [toString] on an [Output<T>] is not supported"* text into the
     * env file, across several lines — which docker rejects outright
     * (`invalid env file … contains whitespaces`, exit 125), so the container
     * never starts and the group reports hosts that never became healthy.
     */
    const environmentNames = Object.keys(request.environment)
    const startupScript = $resolve([
      request.image,
      request.apiUrl,
      $resolve(Object.values(request.secrets)),
      $resolve(Object.values(request.environment)),
    ]).apply(([image, apiUrl, references, resolved]) => {
      /*
       * Not `String(...)` per value. Coercing here is what hid the defect this
       * file's own note describes: it turns an unresolved `Output` into the
       * `[toString]` refusal text and hands it on as a perfectly good string.
       * The values arrive resolved from `$resolve` above, and `proxyEnvLine`
       * refuses anything that is not a string rather than rendering it.
       */
      const values: Record<string, unknown> = {
        ...Object.fromEntries(environmentNames.map((name, index) => [name, (resolved as unknown[])[index]])),
        PROXY_PORT: String(PROXY_PORT),
        PROXY_PROTOCOL: request.protocol,
        // api-client-go appends paths like `/config` directly, so the `/api`
        // prefix belongs here rather than inside the proxy.
        BOXLITE_API_URL: `${String(apiUrl).replace(/\/$/, '')}/api`,
        PROXY_DOMAIN: request.domain,
        /*
         * The collector authorises by caller on this cloud, and enforces it per
         * request against a Google ID token — so a proxy that sends none is
         * answered 403 and exports nothing, exactly as every runner did. The
         * runner provider sets the same flag; see
         * `apps/libs/common-go/pkg/telemetry/gcp_idtoken.go`.
         */
        OTEL_EXPORTER_OTLP_GOOGLE_ID_TOKEN: 'true',
      }
      const plain = Object.entries(values).map(([name, value]) => proxyEnvLine(name, value))
      const secrets = Object.keys(request.secrets).map((name, index) => {
        const { secret, version } = splitSecretRef((references as string[])[index] as string)
        return (
          `printf '%s=%s\\n' ${name} "$(curl -sf -H "Authorization: Bearer $TOKEN" ` +
          `"https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}/versions/${version}:access" ` +
          `| sed -n 's/.*\\"data\\": \\"\\([^\\"]*\\)\\".*/\\1/p' | base64 -d)" >> /run/proxy.env`
        )
      })
      return [
        '#!/bin/bash',
        'set -euo pipefail',
        ': > /run/proxy.env',
        'chmod 600 /run/proxy.env',
        ...(secrets.length > 0
          ? [
              'TOKEN=$(curl -sf -H "Metadata-Flavor: Google" ' +
                'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token ' +
                "| sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')",
              // Fail closed: a proxy started without its API key answers every
              // box request as unauthorized, which reads as a control-plane bug.
              '[ -n "$TOKEN" ] || { echo "no metadata token; refusing to start" >&2; exit 1; }',
            ]
          : []),
        ...plain,
        ...secrets,
        startProxy(String(image), registryHostOf(String(image))),
      ].join('\n')
    })

    const template = new gcp.compute.InstanceTemplate('ProxyTemplate', {
      namePrefix: `${instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' })}-`,
      project,
      region,
      machineType: MACHINE_TYPE,
      disks: [{ sourceImage: COS_IMAGE, autoDelete: true, boot: true, diskSizeGb: 20 }],
      networkInterfaces: [
        {
          subnetwork: placement.subnetwork,
          /*
           * No external address. A passthrough balancer forwarded to the
           * instance's own, so one was required; a proxy balancer reaches the
           * backend over the network instead, and the host's outbound — the
           * image pull — goes through Cloud NAT. That leaves the proxy hosts
           * with no internet-facing address at all, which is strictly better
           * for the one workload that used to have the most exposed one.
           *
           * It is also what `constraints/compute.vmExternalIpAccess` requires:
           * an organization that forbids external addresses refuses the
           * instance outright, and this stack has no reason to ask for one.
           */
        },
      ],
      serviceAccount: { email: placement.serviceAccount, scopes: ['cloud-platform'] },
      metadata: { 'startup-script': startupScript },
      // A template is immutable, so a change makes a new one and the group
      // rolls onto it rather than failing on an in-place update.
      lifecycle: { createBeforeDestroy: true },
    })

    /*
     * The two grants this host needs, and the ones Cloud Run never did.
     *
     * A Cloud Run service's image is pulled by Google's own service agent and
     * its stdout is collected by the platform, so nothing in `api.ts` or
     * `collector.ts` grants either of these. This host does both for itself.
     *
     * Without the registry read the group boots, the startup script runs,
     * `docker pull` is denied, and the balancer reports two hosts that never
     * became healthy with nothing in the deploy having failed.
     *
     * Without the log write the container's own output goes nowhere: COS ships
     * journald to Cloud Logging as the instance's service account, and an
     * unhealthy host is then unexplainable — `logging.logEntries.create` denied
     * is the only trace, on the serial console. The AWS side gets this for
     * free, because an ECS task's log driver is the platform's.
     */
    const pull = new gcp.projects.IAMMember('ProxyRegistryReader', {
      project,
      role: 'roles/artifactregistry.reader',
      member: placement.serviceAccount.apply((email: string) => `serviceAccount:${email}`),
    })
    const logs = new gcp.projects.IAMMember('ProxyLogWriter', {
      project,
      role: 'roles/logging.logWriter',
      member: placement.serviceAccount.apply((email: string) => `serviceAccount:${email}`),
    })

    /*
     * Global, because the balancer in front of it is. The values are the AWS
     * target group's, so a host is called healthy or unhealthy by the same
     * question on both clouds.
     *
     * The proxy's own route, on its own port. A TCP check on the port would
     * call a host healthy while the container behind it was still starting.
     */
    const health = new gcp.compute.HealthCheck('ProxyHealthCheck', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      httpHealthCheck: { requestPath: '/health', port: PROXY_PORT },
      checkIntervalSec: 30,
      timeoutSec: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
    })

    const group = new gcp.compute.RegionInstanceGroupManager(
      'Proxy',
      {
        name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
        project,
        region,
        baseInstanceName: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
        versions: [{ instanceTemplate: template.selfLinkUnique }],
        targetSize: 2,
        // One zone, the stage's own. See the note on `zone` above: the rolling
        // policy below is only expressible in a group that spans one.
        distributionPolicyZones: [zone],
        // What the balancer connects to. A proxy load balancer opens its own
        // connection to the backend, so this is the container's port and not
        // the 443 a client dialled.
        namedPorts: [{ name: NAMED_PORT, port: PROXY_PORT }],
        // Rolling, one at a time, with a spare: every running box's connection
        // goes through these, so a group that replaced both at once would drop
        // every session.
        updatePolicy: {
          type: 'PROACTIVE',
          minimalAction: 'REPLACE',
          maxSurgeFixed: 1,
          maxUnavailableFixed: 0,
        },
        // The same check the balancer uses. A group with no autohealing keeps
        // a host that stopped answering in rotation until someone notices.
        autoHealingPolicies: { healthCheck: health.id, initialDelaySec: 300 },
      },
      { dependsOn },
    )

    const backend = new gcp.compute.BackendService('ProxyBackend', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      // A proxy balancer: it terminates the client's TLS and opens its own
      // plaintext connection to the group, which is what the AWS NLB's
      // `443/tls` listener does.
      loadBalancingScheme: 'EXTERNAL_MANAGED',
      protocol: 'TCP',
      portName: NAMED_PORT,
      healthChecks: [health.id],
      backends: [{ group: group.instanceGroup, balancingMode: 'UTILIZATION', capacityScaler: 1 }],
      // An hour, matching the API's: a box session held open through a pause
      // must not be closed under it.
      timeoutSec: 3_600,
    })

    /*
     * The wildcard certificate, which is four resources on this cloud.
     *
     * A Google-managed certificate covering `*.<domain>` exists only through
     * Certificate Manager with DNS authorization — the load balancer's own
     * `ManagedSslCertificate` cannot hold a wildcard at all. The authorization
     * publishes a challenge record, the certificate proves the domain with it,
     * a map carries the certificate and the target proxy holds the map.
     *
     * One authorization covers both names: an authorization for `<domain>`
     * answers for `<domain>` and `*.<domain>` alike.
     */
    const authorization = new gcp.certificatemanager.DnsAuthorization('ProxyDnsAuthorization', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      domain: request.domain,
    })
    // The challenge record, in the zone that actually answers for this domain.
    // Without it the certificate never leaves `PROVISIONING`.
    const challenge = new cloudflare.Record('ProxyDnsAuthorizationRecord', {
      zoneId,
      name: authorization.dnsResourceRecords[0].name,
      type: authorization.dnsResourceRecords[0].type,
      content: authorization.dnsResourceRecords[0].data,
      proxied: false,
      ttl: 60,
    })
    // The name is keyed to the domains and the delete comes last; see
    // `certificate-name.ts` for what goes wrong under a fixed name.
    const certificate = new gcp.certificatemanager.Certificate(
      'ProxyCertificate',
      {
        name: certificateNameFor({
          domain: request.domain,
          base: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
        }),
        project,
        // Both names, as the AWS side's `domain` plus `aliases` are: the apex is
        // the proxy itself and the wildcard is every box that will ever exist.
        managed: { domains: [request.domain, `*.${request.domain}`], dnsAuthorizations: [authorization.id] },
      },
      { deleteBeforeReplace: false },
    )
    const certificates = new gcp.certificatemanager.CertificateMap('ProxyCertificateMap', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
    })
    const entry = new gcp.certificatemanager.CertificateMapEntry('ProxyCertificateEntry', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      map: certificates.name,
      certificates: [certificate.id],
      // Everything this balancer answers, rather than a hostname list that
      // would have to name each box.
      matcher: 'PRIMARY',
    })

    const address = new gcp.compute.GlobalAddress('ProxyAddress', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
    })
    const sslProxy = new gcp.compute.TargetSSLProxy('ProxyTargetSslProxy', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      backendService: backend.id,
      certificateMap: certificates.id.apply((id: string) => `//certificatemanager.googleapis.com/${id}`),
    })
    const forwarding = new gcp.compute.GlobalForwardingRule('ProxyForwardingRule', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      loadBalancingScheme: 'EXTERNAL_MANAGED',
      ipProtocol: 'TCP',
      portRange: '443',
      ipAddress: address.address,
      target: sslProxy.id,
    })

    /*
     * The balancer reaches the hosts, and nothing else does.
     *
     * A proxy balancer connects from Google's own front ends rather than from
     * the client, so the source is these two documented ranges and the port is
     * the container's — not `0.0.0.0/0` on 443, which is what a passthrough
     * needed. The same ranges carry the health checks.
     */
    const firewall = new gcp.compute.Firewall('ProxyFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' }),
      project,
      network,
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp', ports: [String(PROXY_PORT)] }],
      sourceRanges: LOAD_BALANCER_RANGES,
      targetServiceAccounts: [placement.serviceAccount],
    })

    /*
     * Two records, not one. The apex is what a client resolves for the proxy
     * itself; the wildcard is every box that will ever exist. Both unproxied:
     * Google's managed certificate is validated by reaching this address, and a
     * proxied record answers from Cloudflare instead — so the certificate would
     * sit in `PROVISIONING` and never leave it.
     */
    const apex = new cloudflare.Record('ProxyRecord', {
      zoneId,
      name: request.domain,
      type: 'A',
      content: address.address,
      proxied: false,
      ttl: 60,
    })
    const wildcard = new cloudflare.Record('ProxyWildcardRecord', {
      zoneId,
      name: `*.${request.domain}`,
      type: 'A',
      content: address.address,
      proxied: false,
      ttl: 60,
    })

    return {
      url: $util.output(`https://${request.domain}`),
      // A log-based metric filters on the group's own name here, where AWS
      // dimensions a metric by the balancer's ARN suffix.
      metricTarget: group.name,
      ready: [group, forwarding, firewall, pull, logs, entry, challenge, apex, wildcard],
    }
  }
