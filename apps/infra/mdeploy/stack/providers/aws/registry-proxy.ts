import type { RegistryCredentialStore } from '../../registry-credentials.ts'
import type { RegistryProxyProvider } from '../../registry-proxy.ts'
import { REGISTRY_PROXY_HEALTH_PATH, REGISTRY_PROXY_PORT } from '../../registry-proxy.ts'
import type { Placement } from '../../network.ts'
import type { WorkloadHost } from '../../cluster.ts'
import { awsCertificate, awsDnsName } from './certificate.ts'
import { awsRuntimeRole, awsService } from './service.ts'

export const awsRegistryProxyProvider =
  ({
    host,
    placement,
    runnerPlacement,
    domain,
    zoneId,
    registryCredentials,
    dependsOn,
  }: {
    runnerPlacement: Extract<Placement, { cloud: 'aws' }>
    host: Extract<WorkloadHost, { cloud: 'aws' }>
    placement: Extract<Placement, { cloud: 'aws' }>
    domain: string
    zoneId: string
    registryCredentials: RegistryCredentialStore
    dependsOn: CloudResource[]
  }): RegistryProxyProvider =>
  (request) => {
    if (!registryCredentials.active || registryCredentials.binding.cloud !== 'aws')
      throw new Error('The AWS registry proxy needs an AWS credential store')
    const network = host.cluster.network
    const hostname = `registry.${domain}`
    const certificate = awsCertificate('RegistryProxyCertificate', [{ domain: hostname, zoneId }])
    const ingress = new aws.ec2.SecurityGroup('RegistryProxyBalancerSecurityGroup', {
      vpcId: network.vpcId,
      ingress: [{ protocol: 'tcp', fromPort: 443, toPort: 443, securityGroups: runnerPlacement.securityGroups }],
      egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: [network.cidr] }],
    })
    const allowTask = new aws.vpc.SecurityGroupIngressRule('RegistryProxyIngressFromBalancer', {
      securityGroupId: placement.securityGroups[0],
      referencedSecurityGroupId: ingress.id,
      ipProtocol: 'tcp',
      fromPort: REGISTRY_PROXY_PORT,
      toPort: REGISTRY_PROXY_PORT,
    })
    const balancer = new aws.lb.LoadBalancer('RegistryProxyLoadBalancer', {
      internal: true,
      loadBalancerType: 'network',
      subnets: network.privateSubnets,
      securityGroups: [ingress.id],
      enableCrossZoneLoadBalancing: true,
    })
    const target = new aws.lb.TargetGroup('RegistryProxyTarget', {
      vpcId: network.vpcId,
      targetType: 'ip',
      protocol: 'TCP',
      port: REGISTRY_PROXY_PORT,
      healthCheck: { protocol: 'HTTP', path: REGISTRY_PROXY_HEALTH_PATH, matcher: '200', port: 'traffic-port' },
    })
    const listener = new aws.lb.Listener('RegistryProxyListener', {
      loadBalancerArn: balancer.arn,
      port: 443,
      protocol: 'TLS',
      certificateArn: certificate.certificateArn,
      defaultActions: [{ type: 'forward', targetGroupArn: target.arn }],
    })
    const role = awsRuntimeRole('RegistryProxyTaskRole', 'ecs-tasks.amazonaws.com')
    const read = new aws.iam.RolePolicy('RegistryProxySecretRead', {
      role: role.name,
      policy: registryCredentials.binding.readGrant,
    })
    const service = awsService('RegistryProxy', {
      host,
      placement,
      image: request.image,
      port: REGISTRY_PROXY_PORT,
      taskRole: role,
      environment: request.environment,
      targets: [{ targetGroupArn: target.arn, containerPort: REGISTRY_PROXY_PORT }],
      dependsOn: [...dependsOn, listener, allowTask, read],
    })
    const record = awsDnsName('RegistryProxyRecord', hostname, zoneId, balancer.dnsName)
    return { active: true, url: $util.output(`https://${hostname}`), ready: [...service.ready, record] }
  }
