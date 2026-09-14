/*
 * The GCP box proxy: a GKE Deployment behind the existing global SSL proxy
 * load balancer.
 *
 * TLS still terminates at Google's target SSL proxy. The proxy routes on the
 * HTTP Host header, not SNI, so the Pod receives the same plaintext stream the
 * old VM container did. The only backend change is from a managed instance
 * group to a standalone `GCE_VM_IP_PORT` NEG populated by GKE.
 *
 * The API key takes a different path from every ordinary environment value:
 * Secret Manager -> managed GKE CSI provider -> read-only Pod volume -> file.
 * No Kubernetes Secret and no secret-valued environment variable is created.
 * The Pod's Kubernetes service account impersonates the existing proxy Google
 * service account through Workload Identity, which preserves its Cloud Run
 * invoker identity and gives the CSI provider one narrowly scoped principal.
 */

import type { WorkloadHost } from '../../cluster.ts'
import type { Edge, EdgeProvider, EdgeRequest } from '../../edge.ts'
import { PROXY_PORT } from '../../edge.ts'
import type { Placement } from '../../network.ts'
import { RUNNER_PORT } from '../../runners.ts'
import { certificateNameFor } from './certificate-name.ts'
import { GKE_POD_CIDR, SUBNET_CIDR } from './network.ts'
import { secretCoordinatesOf, versionedSecretRef } from './secret-env.ts'
import { instanceFor } from 'naming'

const NAMESPACE = 'boxlite'
const KUBERNETES_SERVICE_ACCOUNT = 'proxy'
const CONTAINER = 'proxy'
const SECRET_PROVIDER_CLASS = 'proxy'
const SECRET_VOLUME = 'proxy-secrets'
const SECRET_MOUNT = '/var/run/secrets/boxlite'
const PROXY_API_KEY = 'PROXY_API_KEY'
const PROXY_API_KEY_PATH = 'proxy-api-key'
export const PROXY_API_KEY_FILE = `${SECRET_MOUNT}/${PROXY_API_KEY_PATH}`

const REPLICAS = 2
const MAX_CONNECTIONS_PER_POD = 10_000
const LOAD_BALANCER_RANGES = ['130.211.0.0/22', '35.191.0.0/16']

/** The managed CSI provider's value: JSON is also valid YAML. */
export const secretProviderParameters = (reference: string): string =>
  JSON.stringify([{ resourceName: versionedSecretRef(reference), path: PROXY_API_KEY_PATH }])

const gsaMember = (email: string): string => `serviceAccount:${email}`

export const gcpEdgeProvider =
  ({
    project,
    host,
    placement,
    network,
    runnerServiceAccount,
    zoneId,
    dependsOn,
  }: {
    project: string
    host: Extract<WorkloadHost, { cloud: 'gcp'; runtime: 'gke' }>
    placement: Extract<Placement, { cloud: 'gcp' }>
    /** The VPC self link both firewall rules attach to. */
    network: $util.Output<string>
    /** The runner is the only VM a Proxy Pod accepts a direct route to. */
    runnerServiceAccount: $util.Output<string>
    zoneId: string
    dependsOn: any[]
  }): EdgeProvider =>
  (request: EdgeRequest): Edge => {
    const name = instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' })

    /*
     * Prefer the store's by-reference channel. For an existing stage that still
     * carries the key as a value, copy it once into a stack-owned Secret Manager
     * version so this VM -> GKE replacement does not require an outage-causing
     * store migration first. New stages should pin a Secret Manager version in
     * `env.selectGroup.secret`; that path never puts the payload in Pulumi state.
     */
    const unexpectedSecrets = Object.keys(request.secrets).filter((key) => key !== PROXY_API_KEY)
    if (unexpectedSecrets.length > 0) {
      throw new Error(`the GKE proxy has no file reader for ${unexpectedSecrets.join(', ')}`)
    }
    const storedReference = request.secrets[PROXY_API_KEY]
    const inlineKey = request.environment[PROXY_API_KEY]
    if (storedReference !== undefined && inlineKey !== undefined) {
      throw new Error(`${PROXY_API_KEY} reached the GKE proxy through both its value and reference channels`)
    }

    let secretReference: $util.Input<string>
    const ownedSecretResources: any[] = []
    if (storedReference !== undefined) {
      secretReference = storedReference
    } else {
      if (inlineKey === undefined || (typeof inlineKey === 'string' && inlineKey.length === 0)) {
        throw new Error(`${PROXY_API_KEY} reached neither the GKE proxy's value nor its reference channel`)
      }
      const secret = new gcp.secretmanager.Secret('ProxyApiKeySecret', {
        project,
        secretId: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy-api-key' }),
        replication: { auto: {} },
      })
      const version = new gcp.secretmanager.SecretVersion('ProxyApiKeyValue', {
        secret: secret.id,
        secretData: $util.secret(inlineKey),
      })
      secretReference = version.name
      ownedSecretResources.push(secret, version)
    }

    const reference = $util.output(secretReference)
    const coordinates = reference.apply(secretCoordinatesOf)
    const mountedReference = reference.apply(versionedSecretRef)

    /*
     * The binding waits for the cluster, because the pool it names is the
     * cluster's.
     *
     * `<project>.svc.id.goog` does not exist until a cluster with Workload
     * Identity has been created; granted before that, the API refuses the whole
     * policy with `Error 400: Identity Pool does not exist`. Nothing in the
     * argument list expresses that order — the member is a plain string — so
     * the dependency has to be stated, and a real deploy proved it: the binding
     * failed seven seconds in, while the cluster was still being created.
     */
    const workloadIdentity = new gcp.serviceaccount.IAMMember(
      'ProxyWorkloadIdentity',
      {
        serviceAccountId: placement.serviceAccount.apply(
          (email: string) => `projects/${project}/serviceAccounts/${email}`,
        ),
        role: 'roles/iam.workloadIdentityUser',
        member: `serviceAccount:${project}.svc.id.goog[${NAMESPACE}/${KUBERNETES_SERVICE_ACCOUNT}]`,
      },
      { dependsOn: host.ready },
    )
    const secretAccessor = new gcp.secretmanager.SecretIamMember('ProxySecretAccessor', {
      project: coordinates.apply(({ project: secretProject }: { project: string }) => secretProject),
      secretId: coordinates.apply(({ secret }: { secret: string }) => secret),
      role: 'roles/secretmanager.secretAccessor',
      member: placement.serviceAccount.apply(gsaMember),
    })

    const k8s = { provider: host.provider }
    const namespace = new kubernetes.core.v1.Namespace('ProxyNamespace', { metadata: { name: NAMESPACE } }, k8s)
    const serviceAccount = new kubernetes.core.v1.ServiceAccount(
      'ProxyKubernetesServiceAccount',
      {
        metadata: {
          name: KUBERNETES_SERVICE_ACCOUNT,
          namespace: namespace.metadata.name,
          annotations: {
            'iam.gke.io/gcp-service-account': placement.serviceAccount,
            'iam.gke.io/return-principal-id-as-email': 'true',
          },
        },
      },
      { ...k8s, dependsOn: [workloadIdentity] },
    )
    const secretProvider = new kubernetes.apiextensions.CustomResource(
      'ProxySecretProviderClass',
      {
        apiVersion: 'secrets-store.csi.x-k8s.io/v1',
        kind: 'SecretProviderClass',
        metadata: { name: SECRET_PROVIDER_CLASS, namespace: namespace.metadata.name },
        spec: {
          provider: 'gke',
          parameters: { secrets: reference.apply(secretProviderParameters) },
        },
      },
      { ...k8s, dependsOn: [...host.ready, secretAccessor, ...ownedSecretResources] },
    )

    /*
     * Create the annotated Service before any selected Pod. The NEG controller
     * injects a readiness gate only when it sees the Service as the Pod is
     * admitted. Awaiting endpoints here would deadlock, so this resource alone
     * skips Pulumi's Service await; the Deployment below supplies the real wait.
     */
    const service = new kubernetes.core.v1.Service(
      'ProxyService',
      {
        metadata: {
          name: CONTAINER,
          namespace: namespace.metadata.name,
          annotations: {
            'cloud.google.com/neg': JSON.stringify({ exposed_ports: { [PROXY_PORT]: { name } } }),
            'pulumi.com/skipAwait': 'true',
          },
        },
        spec: {
          type: 'ClusterIP',
          selector: { 'app.kubernetes.io/name': CONTAINER },
          ports: [{ name: CONTAINER, protocol: 'TCP', port: PROXY_PORT, targetPort: CONTAINER }],
        },
      },
      { ...k8s, dependsOn: [namespace] },
    )

    const plainEnvironment = { ...request.environment }
    delete plainEnvironment[PROXY_API_KEY]
    const environment: Record<string, $util.Input<string>> = {
      ...plainEnvironment,
      PROXY_PORT: String(PROXY_PORT),
      PROXY_PROTOCOL: request.protocol,
      BOXLITE_API_URL: $util.output(request.apiUrl).apply((url: string) => `${url.replace(/\/$/, '')}/api`),
      PROXY_DOMAIN: request.domain,
      PROXY_API_KEY_FILE,
    }

    const labels = { 'app.kubernetes.io/name': CONTAINER, 'app.kubernetes.io/component': 'edge' }
    const deployment = new kubernetes.apps.v1.Deployment(
      'ProxyDeployment',
      {
        metadata: { name: CONTAINER, namespace: namespace.metadata.name, labels },
        spec: {
          replicas: REPLICAS,
          minReadySeconds: 10,
          strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
          selector: { matchLabels: { 'app.kubernetes.io/name': CONTAINER } },
          template: {
            metadata: {
              labels,
              // A pinned reference changes the Pod template and rolls both
              // readers. An unversioned reference remains explicitly latest.
              annotations: { 'boxlite.ai/proxy-api-key-version': mountedReference },
            },
            spec: {
              serviceAccountName: serviceAccount.metadata.name,
              automountServiceAccountToken: true,
              /*
               * Longer than the hour the load balancer drains for, on purpose.
               *
               * Three timeouts in a row: the backend drains a removed endpoint
               * for 3600s, the proxy shuts down gracefully for the same, and the
               * kubelet must outlast both or it SIGKILLs a Pod that is still
               * serving connections the balancer believes it is draining. The
               * minute of headroom is what keeps the last of them from being cut.
               */
              terminationGracePeriodSeconds: 3_660,
              nodeSelector: { 'iam.gke.io/gke-metadata-server-enabled': 'true' },
              topologySpreadConstraints: [
                {
                  maxSkew: 1,
                  topologyKey: 'topology.kubernetes.io/zone',
                  whenUnsatisfiable: 'ScheduleAnyway',
                  labelSelector: { matchLabels: { 'app.kubernetes.io/name': CONTAINER } },
                },
              ],
              securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
              containers: [
                {
                  name: CONTAINER,
                  image: request.image,
                  imagePullPolicy: 'IfNotPresent',
                  ports: [{ name: CONTAINER, containerPort: PROXY_PORT, protocol: 'TCP' }],
                  env: Object.entries(environment).map(([name, value]) => ({ name, value })),
                  volumeMounts: [{ name: SECRET_VOLUME, mountPath: SECRET_MOUNT, readOnly: true }],
                  startupProbe: {
                    httpGet: { path: '/health', port: CONTAINER, scheme: 'HTTP' },
                    periodSeconds: 5,
                    failureThreshold: 60,
                  },
                  readinessProbe: {
                    httpGet: { path: '/health', port: CONTAINER, scheme: 'HTTP' },
                    periodSeconds: 10,
                    timeoutSeconds: 5,
                    failureThreshold: 3,
                  },
                  livenessProbe: {
                    httpGet: { path: '/health', port: CONTAINER, scheme: 'HTTP' },
                    periodSeconds: 30,
                    timeoutSeconds: 5,
                    failureThreshold: 3,
                  },
                  resources: {
                    requests: { cpu: '250m', memory: '256Mi' },
                    limits: { cpu: '1', memory: '512Mi' },
                  },
                  securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
                },
              ],
              volumes: [
                {
                  name: SECRET_VOLUME,
                  csi: {
                    driver: 'secrets-store-gke.csi.k8s.io',
                    readOnly: true,
                    volumeAttributes: { secretProviderClass: secretProvider.metadata.name },
                  },
                },
              ],
            },
          },
        },
      },
      {
        ...k8s,
        dependsOn: [
          service,
          serviceAccount,
          secretProvider,
          workloadIdentity,
          secretAccessor,
          ...host.ready,
          ...dependsOn,
          ...ownedSecretResources,
        ],
        customTimeouts: { create: '20m', update: '20m' },
      },
    )

    /*
     * What a Pod may talk to, denied by default.
     *
     * The VPC firewall already says who reaches the node and who the node
     * reaches, but every Pod in this cluster shares those rules — inside the
     * cluster the proxy is otherwise reachable by anything that lands in the
     * namespace. This is the half only Kubernetes can express, and it is worth
     * having precisely because the proxy's whole job is opening connections on
     * behalf of a caller: a compromised one with no egress policy is a tunnel
     * into the VPC.
     *
     * Deny first, then name the five things it genuinely needs. Enforced by
     * Dataplane V2, which `cluster.ts` turns on at creation.
     */
    const denyAll = new kubernetes.networking.v1.NetworkPolicy(
      'ProxyDefaultDeny',
      {
        metadata: { name: 'default-deny', namespace: namespace.metadata.name },
        spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
      },
      { ...k8s, dependsOn: [namespace] },
    )

    new kubernetes.networking.v1.NetworkPolicy(
      'ProxyNetworkPolicy',
      {
        metadata: { name: CONTAINER, namespace: namespace.metadata.name },
        spec: {
          podSelector: { matchLabels: { 'app.kubernetes.io/name': CONTAINER } },
          policyTypes: ['Ingress', 'Egress'],
          // Only the balancer's own ranges, and only the port it forwards to.
          // Health checks arrive from the same two ranges.
          ingress: [
            {
              from: LOAD_BALANCER_RANGES.map((cidr) => ({ ipBlock: { cidr } })),
              ports: [{ protocol: 'TCP', port: PROXY_PORT }],
            },
          ],
          egress: [
            // Cluster DNS. Named by namespace rather than by address: kube-dns
            // has a Service IP this module has no way to know.
            {
              to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
              ports: [
                { protocol: 'UDP', port: 53 },
                { protocol: 'TCP', port: 53 },
              ],
            },
            // The GKE metadata server, which is how Workload Identity mints the
            // token the proxy calls the control plane with.
            {
              to: [{ ipBlock: { cidr: '169.254.169.254/32' } }],
              ports: [
                { protocol: 'TCP', port: 80 },
                { protocol: 'TCP', port: 988 },
              ],
            },
            // The runner fleet, on its one port. The VPC firewall admits this
            // from the Pod range; this is the same statement from inside.
            {
              to: [{ ipBlock: { cidr: SUBNET_CIDR } }],
              ports: [{ protocol: 'TCP', port: RUNNER_PORT }],
            },
            // The control plane, the collector and Secret Manager: all public
            // addresses reached over TLS, so the destination cannot be narrowed
            // to a range this module could name.
            {
              to: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
              ports: [{ protocol: 'TCP', port: 443 }],
            },
          ],
        },
      },
      { ...k8s, dependsOn: [denyAll] },
    )

    const disruptionBudget = new kubernetes.policy.v1.PodDisruptionBudget(
      'ProxyDisruptionBudget',
      {
        metadata: { name: CONTAINER, namespace: namespace.metadata.name },
        spec: { minAvailable: 1, selector: { matchLabels: { 'app.kubernetes.io/name': CONTAINER } } },
      },
      { ...k8s, dependsOn: [deployment] },
    )

    /*
     * Deployment readiness is the NEG wait: because the Service pre-existed the
     * Pods, GKE injects its readiness gate and does not mark the Deployment
     * available until each endpoint has been registered. The invoke can then
     * read a real NEG instead of racing the controller with a guessed self link.
     */
    const negLinks = host.zones.apply((zones: string[]) => {
      if (zones.length === 0) {
        throw new Error('the proxy cluster reported no zones, so its NEGs cannot be found')
      }
      return $resolve(
        zones.map((zone) =>
          gcp.compute
            .getNetworkEndpointGroupOutput({ project, zone, name }, { dependsOn: [deployment] })
            .selfLink.apply((selfLink: string | undefined) => {
              if (!selfLink) throw new Error(`GKE created no self link for proxy NEG ${name} in ${zone}`)
              return selfLink
            }),
        ),
      )
    })

    const health = new gcp.compute.HealthCheck('ProxyHealthCheck', {
      name,
      project,
      httpHealthCheck: { requestPath: '/health', port: PROXY_PORT },
      checkIntervalSec: 30,
      timeoutSec: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
      // The alarm consumes health transitions from this exact NEG.
      logConfig: { enable: true },
    })
    const backend = new gcp.compute.BackendService(
      'ProxyBackend',
      {
        name,
        project,
        loadBalancingScheme: 'EXTERNAL_MANAGED',
        protocol: 'TCP',
        healthChecks: [health.id],
        /*
         * One backend per zone, because a standalone NEG is zonal.
         *
         * The cluster reports where it runs nodes and GKE creates a NEG in each
         * of those zones; a backend list built from one of them would carry the
         * Pods that happened to land there and leave the rest unreachable — with
         * every health check green, because the endpoints that are missing are
         * the ones nothing is checking.
         */
        backends: negLinks.apply((links: string[]) =>
          links.map((group) => ({
            group,
            balancingMode: 'CONNECTION',
            maxConnectionsPerEndpoint: MAX_CONNECTIONS_PER_POD,
            capacityScaler: 1,
          })),
        ),
        timeoutSec: 3_600,
        connectionDrainingTimeoutSec: 3_600,
      },
      { dependsOn: [deployment] },
    )

    const authorization = new gcp.certificatemanager.DnsAuthorization('ProxyDnsAuthorization', {
      name,
      project,
      domain: request.domain,
    })
    const challenge = new cloudflare.Record('ProxyDnsAuthorizationRecord', {
      zoneId,
      name: authorization.dnsResourceRecords[0].name,
      type: authorization.dnsResourceRecords[0].type,
      content: authorization.dnsResourceRecords[0].data,
      proxied: false,
      ttl: 60,
    })
    const certificate = new gcp.certificatemanager.Certificate(
      'ProxyCertificate',
      {
        name: certificateNameFor({ domain: request.domain, base: name }),
        project,
        managed: { domains: [request.domain, `*.${request.domain}`], dnsAuthorizations: [authorization.id] },
      },
      { deleteBeforeReplace: false },
    )
    const certificates = new gcp.certificatemanager.CertificateMap('ProxyCertificateMap', { name, project })
    const entry = new gcp.certificatemanager.CertificateMapEntry('ProxyCertificateEntry', {
      name,
      project,
      map: certificates.name,
      certificates: [certificate.id],
      matcher: 'PRIMARY',
    })

    // These logical names are unchanged, so the IP, certificate map binding and
    // DNS records stay in place while only ProxyBackend changes its group.
    const address = new gcp.compute.GlobalAddress('ProxyAddress', { name, project })
    const sslProxy = new gcp.compute.TargetSSLProxy('ProxyTargetSslProxy', {
      name,
      project,
      backendService: backend.id,
      certificateMap: certificates.id.apply((id: string) => `//certificatemanager.googleapis.com/${id}`),
    })
    const forwarding = new gcp.compute.GlobalForwardingRule('ProxyForwardingRule', {
      name,
      project,
      loadBalancingScheme: 'EXTERNAL_MANAGED',
      ipProtocol: 'TCP',
      portRange: '443',
      ipAddress: address.address,
      target: sslProxy.id,
    })

    const loadBalancerIngress = new gcp.compute.Firewall('ProxyFirewall', {
      name,
      project,
      network,
      direction: 'INGRESS',
      allows: [{ protocol: 'tcp', ports: [String(PROXY_PORT)] }],
      sourceRanges: LOAD_BALANCER_RANGES,
      targetServiceAccounts: [host.nodeServiceAccount],
    })
    const runnerIngress = new gcp.compute.Firewall('ProxyToRunnerFirewall', {
      name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy-to-runner' }),
      project,
      network,
      direction: 'INGRESS',
      priority: 1000,
      allows: [{ protocol: 'tcp', ports: [String(RUNNER_PORT)] }],
      sourceRanges: [GKE_POD_CIDR],
      targetServiceAccounts: [runnerServiceAccount],
    })

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
      /*
       * The alarm keys on one NEG's numeric id, and there are now as many NEGs
       * as zones. The first zone the cluster reports is the one carried: an
       * alert per zone would be three alerts for one outage, and the filter has
       * room for exactly one resource label.
       */
      metricTarget: host.zones.apply((zones: string[]) =>
        gcp.compute
          .getNetworkEndpointGroupOutput({ project, zone: zones[0] as string, name }, { dependsOn: [deployment] })
          .generatedId.apply(String),
      ),
      ready: [
        deployment,
        service,
        disruptionBudget,
        backend,
        forwarding,
        loadBalancerIngress,
        runnerIngress,
        workloadIdentity,
        secretAccessor,
        entry,
        challenge,
        apex,
        wildcard,
        ...ownedSecretResources,
      ],
    }
  }
