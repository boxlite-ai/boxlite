import type { WorkloadHost } from '../../cluster.ts'
import type { Edge, EdgeProvider, EdgeRequest } from '../../edge.ts'
import { PROXY_PORT } from '../../edge.ts'
import type { Placement } from '../../network.ts'
import { awsCertificate, awsDnsName, proxyCertificateDomains } from './certificate.ts'
import { awsService } from './service.ts'
import { instanceFor } from 'naming'
import { createHash } from 'node:crypto'

/** Stable within AWS's 32-character load-balancer name limit. */
export const proxyLoadBalancerName = (): string => {
  const name = instanceFor({ app: $app.name, stage: $app.stage, artifact: 'proxy' })
  return name.length <= 32
    ? name
    : name.slice(0, 23) + '-' + createHash('sha256').update(name).digest('hex').slice(0, 8)
}

export const awsEdgeProvider =
  ({
    host,
    placement,
    zoneId,
    dependsOn,
  }: {
    host: Extract<WorkloadHost, { cloud: 'aws' }>
    placement: Extract<Placement, { cloud: 'aws' }>
    zoneId: string
    dependsOn: CloudResource[]
  }): EdgeProvider =>
  (request: EdgeRequest): Edge => {
    const network = host.cluster.network
    const certificate = awsCertificate(
      'ProxyCertificate',
      proxyCertificateDomains(request.domain, zoneId, request.userDomain),
    )
    const ingress = new aws.ec2.SecurityGroup('ProxyBalancerSecurityGroup', {
      vpcId: network.vpcId,
      ingress: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] }],
      egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: [network.cidr] }],
    })
    const allowTask = new aws.vpc.SecurityGroupIngressRule('ProxyIngressFromBalancer', {
      securityGroupId: placement.securityGroups[0],
      referencedSecurityGroupId: ingress.id,
      ipProtocol: 'tcp',
      fromPort: PROXY_PORT,
      toPort: PROXY_PORT,
    })
    const balancer = new aws.lb.LoadBalancer(
      'ProxyLoadBalancer',
      {
        name: proxyLoadBalancerName(),
        loadBalancerType: 'network',
        subnets: network.publicSubnets,
        securityGroups: [ingress.id],
        enableCrossZoneLoadBalancing: true,
      },
      { protect: true },
    )
    const target = new aws.lb.TargetGroup(
      'ProxyTarget',
      {
        vpcId: network.vpcId,
        targetType: 'ip',
        protocol: 'TCP',
        port: PROXY_PORT,
        healthCheck: {
          path: '/health',
          protocol: 'HTTP',
          matcher: '200-399',
          port: 'traffic-port',
          interval: 30,
          healthyThreshold: 2,
          unhealthyThreshold: 3,
        },
      },
      { protect: true },
    )
    const listener = new aws.lb.Listener(
      'ProxyListener',
      {
        loadBalancerArn: balancer.arn,
        port: 443,
        protocol: 'TLS',
        certificateArn: certificate.certificateArn,
        defaultActions: [{ type: 'forward', targetGroupArn: target.arn }],
      },
      { protect: true },
    )
    const service = awsService('Proxy', {
      host,
      placement,
      image: request.image,
      port: PROXY_PORT,
      environment: {
        ...request.environment,
        PROXY_PORT: String(PROXY_PORT),
        PROXY_PROTOCOL: request.protocol,
        PROXY_DOMAIN: request.domain,
        BOXLITE_API_URL: $interpolate`${request.apiUrl}/api`,
      },
      secrets: request.secrets,
      targets: [{ targetGroupArn: target.arn, containerPort: PROXY_PORT }],
      dependsOn: [...dependsOn, listener, allowTask],
    })
    const records = [
      awsDnsName('ProxyRecord', request.domain, zoneId, balancer.dnsName),
      awsDnsName('ProxyWildcardRecord', '*.' + request.domain, zoneId, balancer.dnsName),
      ...(request.userDomain
        ? [
            awsDnsName(
              'ProxyAppWildcardRecord',
              '*.' + request.userDomain.domain,
              request.userDomain.dnsZoneId,
              balancer.dnsName,
            ),
          ]
        : []),
    ]
    return {
      url: $util.output(`https://${request.domain}`),
      metricTarget: balancer.arnSuffix,
      ready: [...service.ready, ...records],
    }
  }
