import type { ClickHouse } from '../../clickhouse.ts'
import { CLICKHOUSE_PASSWORD_VARIABLE } from '../../clickhouse.ts'
import type { CollectorProvider } from '../../collector.ts'
import { COLLECTOR_HEALTH_PORT, OTLP_HTTP_PORT } from '../../collector.ts'
import type { WorkloadHost } from '../../cluster.ts'
import { awsService } from './service.ts'

export const awsCollectorProvider =
  ({
    host,
    clickhouse,
    dependsOn,
  }: {
    host: Extract<WorkloadHost, { cloud: 'aws' }>
    clickhouse: ClickHouse
    dependsOn: CloudResource[]
  }): CollectorProvider =>
  (request) => {
    const network = host.cluster.network
    const ingress = new aws.ec2.SecurityGroup('CollectorBalancerSecurityGroup', {
      vpcId: network.vpcId,
      ingress: [80, OTLP_HTTP_PORT].map((port) => ({
        protocol: 'tcp',
        fromPort: port,
        toPort: port,
        cidrBlocks: [network.cidr],
      })),
      egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: [network.cidr] }],
    })
    const allowed = [OTLP_HTTP_PORT, COLLECTOR_HEALTH_PORT].map(
      (port) =>
        new aws.vpc.SecurityGroupIngressRule(`CollectorIngress${port}`, {
          securityGroupId: network.vpc.securityGroups[0],
          referencedSecurityGroupId: ingress.id,
          ipProtocol: 'tcp',
          fromPort: port,
          toPort: port,
        }),
    )
    const balancer = new aws.lb.LoadBalancer('CollectorLoadBalancer', {
      internal: true,
      loadBalancerType: 'application',
      subnets: network.privateSubnets,
      securityGroups: [ingress.id],
    })
    const targets = [OTLP_HTTP_PORT, COLLECTOR_HEALTH_PORT].map(
      (port) =>
        new aws.lb.TargetGroup(`CollectorTarget${port}`, {
          vpcId: network.vpcId,
          targetType: 'ip',
          protocol: 'HTTP',
          port,
          healthCheck: {
            protocol: 'HTTP',
            path: port === OTLP_HTTP_PORT ? '/' : '/health/status',
            matcher: port === OTLP_HTTP_PORT ? '200-499' : '200',
          },
        }),
    )
    const listeners = targets.map(
      (target, index) =>
        new aws.lb.Listener(`CollectorListener${index}`, {
          loadBalancerArn: balancer.arn,
          port: index === 0 ? OTLP_HTTP_PORT : 80,
          protocol: 'HTTP',
          defaultActions: [{ type: 'forward', targetGroupArn: target.arn }],
        }),
    )
    const service = awsService('OtelCollector', {
      host,
      placement: {
        cloud: 'aws',
        exposure: 'private',
        subnets: network.privateSubnets,
        securityGroups: network.vpc.securityGroups,
      },
      image: request.image,
      port: OTLP_HTTP_PORT,
      wait: clickhouse.active,
      command: [
        '--config',
        '/otelcol/collector-config.yaml',
        ...['traces', 'metrics', 'logs'].flatMap((signal) => [
          '--set',
          `service::pipelines::${signal}::exporters=${request.exporters}`,
        ]),
      ],
      environment: request.environment,
      secrets: {
        ...request.secrets,
        ...(clickhouse.active ? { [CLICKHOUSE_PASSWORD_VARIABLE]: clickhouse.writer.passwordRef } : {}),
      },
      targets: targets.map((target, index) => ({
        targetGroupArn: target.arn,
        containerPort: index === 0 ? OTLP_HTTP_PORT : COLLECTOR_HEALTH_PORT,
      })),
      dependsOn: [...dependsOn, ...listeners, ...allowed],
    })
    return { otlpUrl: $interpolate`http://${balancer.dnsName}:${OTLP_HTTP_PORT}`, ready: service.ready }
  }
