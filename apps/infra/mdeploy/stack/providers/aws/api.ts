import type { Api, ApiCapability, ApiDependencies, ApiProvider, ApiRequest } from '../../api.ts'
import { publicHostsFor } from '../../api.ts'
import { CACHE_PASSWORD_VARIABLE } from '../../cache.ts'
import { CLICKHOUSE_PASSWORD_VARIABLE } from '../../clickhouse.ts'
import { DATABASE_PASSWORD_VARIABLE } from '../../database.ts'
import type { Placement } from '../../network.ts'
import type { WorkloadHost } from '../../cluster.ts'
import { awsCertificate, awsDnsName } from './certificate.ts'
import { awsRuntimeRole, awsService } from './service.ts'
import { instanceFor } from 'naming'

const policy = (Statement: unknown[]) => JSON.stringify({ Version: '2012-10-17', Statement })
const storageOnAws = (capability: Extract<ApiCapability, { storage: unknown }>) => {
  const binding = capability.storage.binding
  if (binding.cloud !== 'aws') throw new Error('The AWS API needs AWS storage')
  return binding
}

/** Expand capabilities at the provider boundary; the common stack never constructs IAM. */
export const awsApiGrantsFor = (capability: ApiCapability): $util.Input<string>[] => {
  switch (capability.kind) {
    case 'list-own-bucket':
      return [storageOnAws(capability).listGrant]
    case 'manage-volume-buckets':
      return [storageOnAws(capability).lifecycleGrant]
    case 'vend-volume-credentials':
      return [
        storageOnAws(capability).credentialVending.roleArn.apply((arn: string) =>
          policy([{ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: arn }]),
        ),
      ]
    case 'read-telemetry':
      return capability.clickhouse.active
        ? [
            capability.clickhouse.reader.passwordRef.apply((arn: string) =>
              policy([{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: arn }]),
            ),
          ]
        : []
    case 'read-secret':
      return [
        capability.ref.apply((arn: string) =>
          policy([{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: arn }]),
        ),
      ]
    case 'write-registry-credentials': {
      const binding = capability.store.binding
      if (binding.cloud !== 'aws') throw new Error('The AWS API needs an AWS registry credential store')
      return [binding.writeGrant]
    }
    case 'manage-checkpoint-archives':
      return [
        capability.checkpoints.bucket.apply((bucket: string) =>
          policy([{ Effect: 'Allow', Action: 's3:DeleteObject', Resource: `arn:aws:s3:::${bucket}/checkpoints/*` }]),
        ),
      ]
    case 'read-filestore-instances':
      throw new Error('AWS has no GCP Filestore instances to read')
    case 'resize-runner-disks':
      return [
        $resolve([aws.getCallerIdentityOutput({}).accountId, aws.getRegionOutput({}).name]).apply(([account, region]) =>
          policy([
            {
              Effect: 'Allow',
              Action: 'ec2:ModifyVolume',
              Resource: `arn:aws:ec2:${region}:${account}:volume/*`,
              Condition: {
                StringEquals: {
                  'ec2:ResourceTag/boxlite:app': $app.name,
                  'ec2:ResourceTag/boxlite:stage': $app.stage,
                  'ec2:ResourceTag/boxlite:role': 'runner-data',
                },
              },
            },
            { Effect: 'Allow', Action: ['ec2:DescribeVolumes', 'ec2:DescribeVolumesModifications'], Resource: '*' },
          ]),
        ),
      ]
  }
}

export const awsApiProvider =
  ({
    dependencies,
    zoneId,
    domain,
    dashboardDomain,
  }: {
    dependencies: ApiDependencies
    zoneId: string
    domain: string
    dashboardDomain: string | null
  }): ApiProvider =>
  (request: ApiRequest): Api => {
    const host = dependencies.host as Extract<WorkloadHost, { cloud: 'aws' }>
    const placement = dependencies.placement as Extract<Placement, { cloud: 'aws' }>
    const network = host.cluster.network
    const hosts = publicHostsFor({ domain, dashboardDomain })
    const certificate = awsCertificate('ApiCertificate', [{ domain: hosts.api, zoneId }])
    const ingress = new aws.ec2.SecurityGroup('ApiBalancerSecurityGroup', {
      vpcId: network.vpcId,
      ingress: [{ protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] }],
      egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: [network.cidr] }],
    })
    const allowTask = new aws.vpc.SecurityGroupIngressRule('ApiIngressFromBalancer', {
      securityGroupId: placement.securityGroups[0],
      referencedSecurityGroupId: ingress.id,
      ipProtocol: 'tcp',
      fromPort: request.port,
      toPort: request.port,
    })
    const balancer = new aws.lb.LoadBalancer('ApiLoadBalancer', {
      loadBalancerType: 'application',
      subnets: network.publicSubnets,
      securityGroups: [ingress.id],
      idleTimeout: 3600,
    })
    const target = new aws.lb.TargetGroup('ApiTarget', {
      vpcId: network.vpcId,
      targetType: 'ip',
      protocol: 'HTTP',
      port: request.port,
      healthCheck: {
        path: '/api/health',
        protocol: 'HTTP',
        matcher: '200',
        interval: 30,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
      },
    })
    const listener = new aws.lb.Listener('ApiListener', {
      loadBalancerArn: balancer.arn,
      port: 443,
      protocol: 'HTTPS',
      certificateArn: certificate.certificateArn,
      defaultActions: [{ type: 'forward', targetGroupArn: target.arn }],
    })
    const role = awsRuntimeRole('ApiTaskRole', 'ecs-tasks.amazonaws.com')
    const grants = request.capabilities.flatMap(awsApiGrantsFor).map(
      (grant, index) =>
        new aws.iam.RolePolicy(`ApiCapability${index}`, {
          role: role.name,
          policy: grant,
        }),
    )
    const storage = dependencies.storage.binding
    if (storage.cloud !== 'aws') throw new Error('The AWS API needs AWS storage')
    const vending = new aws.iam.Role('S3AccessRole', {
      name: storage.credentialVending.roleName,
      assumeRolePolicy: role.arn.apply((arn: string) =>
        policy([{ Effect: 'Allow', Principal: { AWS: arn }, Action: 'sts:AssumeRole' }]),
      ),
    })
    const vendingGrant = new aws.iam.RolePolicy('S3AccessRolePolicy', {
      role: vending.name,
      policy: storage.bucketArn.apply((arn: string) =>
        policy([
          { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${arn}/*` },
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: arn },
        ]),
      ),
    })
    const region = aws.getRegionOutput({}).name
    const account = aws.getCallerIdentityOutput({}).accountId
    const service = awsService('Api', {
      autoscaled: true,
      host,
      placement: {
        ...placement,
        securityGroups: [
          ...placement.securityGroups,
          dependencies.database.binding.clientGrant,
          dependencies.cache.binding.clientGrant,
        ],
      },
      image: request.image,
      port: request.port,
      taskRole: role,
      environment: {
        ...request.environment,
        AWS_REGION: region,
        AWS_ACCOUNT_ID: account,
        S3_ENDPOINT: $interpolate`https://s3.${region}.amazonaws.com`,
        S3_STS_ENDPOINT: $interpolate`https://sts.${region}.amazonaws.com`,
        S3_ACCOUNT_ID: account,
        S3_ROLE_NAME: storage.credentialVending.roleName,
        RUNNER_DISK_CLOUD: 'aws',
        RUNNER_DISK_APP: $app.name,
        RUNNER_DISK_STAGE: $app.stage,
      },
      secrets: {
        ...request.secrets,
        [DATABASE_PASSWORD_VARIABLE]: dependencies.database.binding.passwordRef,
        [CACHE_PASSWORD_VARIABLE]: dependencies.cache.binding.passwordRef,
        ...(dependencies.clickhouse.active
          ? { [CLICKHOUSE_PASSWORD_VARIABLE]: dependencies.clickhouse.reader.passwordRef }
          : {}),
      },
      targets: [{ targetGroupArn: target.arn, containerPort: request.port }],
      dependsOn: [...dependencies.waitFor, listener, allowTask, vendingGrant, ...grants],
    })
    const record = awsDnsName('ApiRecord', hosts.api, zoneId, balancer.dnsName)
    // CloudFront certificates are regional to us-east-1 even when the application is elsewhere.
    const cdnRegion = new aws.Provider('DashboardCertificateRegion', { region: 'us-east-1' })
    const dashboardCertificate = awsCertificate('DashboardCertificate', [{ domain: hosts.dashboard, zoneId }], {
      provider: cdnRegion,
    })
    const cdn = new aws.cloudfront.Distribution(
      'ApiCdn',
      {
        enabled: true,
        aliases: [hosts.dashboard],
        isIpv6Enabled: true,
        origins: [
          {
            originId: 'api',
            domainName: hosts.api,
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: 'https-only',
              originSslProtocols: ['TLSv1.2'],
              originReadTimeout: 60,
            },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: 'api',
          viewerProtocolPolicy: 'redirect-to-https',
          allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
          cachedMethods: ['GET', 'HEAD'],
          compress: true,
          cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          originRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
        },
        restrictions: { geoRestriction: { restrictionType: 'none' } },
        viewerCertificate: {
          acmCertificateArn: dashboardCertificate.certificateArn,
          sslSupportMethod: 'sni-only',
          minimumProtocolVersion: 'TLSv1.2_2021',
        },
        tags: { Name: instanceFor({ app: $app.name, stage: $app.stage, artifact: 'dashboard' }) },
      },
      { dependsOn: [service.service, record] },
    )
    const scaling = new aws.appautoscaling.Target('ApiScalingTarget', {
      serviceNamespace: 'ecs',
      scalableDimension: 'ecs:service:DesiredCount',
      resourceId: $interpolate`service/${host.cluster.name}/${service.service.name}`,
      minCapacity: 1,
      maxCapacity: 4,
    })
    const scalingPolicies = ['CPU', 'Memory'].map(
      (metric) =>
        new aws.appautoscaling.Policy(`Api${metric}Scaling`, {
          serviceNamespace: scaling.serviceNamespace,
          scalableDimension: scaling.scalableDimension,
          resourceId: scaling.resourceId,
          policyType: 'TargetTrackingScaling',
          targetTrackingScalingPolicyConfiguration: {
            predefinedMetricSpecification: { predefinedMetricType: `ECSServiceAverage${metric}Utilization` },
            targetValue: 70,
          },
        }),
    )
    const dashboardRecord = awsDnsName('DashboardRecord', hosts.dashboard, zoneId, cdn.domainName)
    return {
      url: $util.output(`https://${hosts.dashboard}`),
      address: $util.output(`https://${hosts.api}`),
      identity: role.arn,
      metricTarget: balancer.arnSuffix,
      metricLogGroup: service.logGroup,
      ready: [...service.ready, ...grants, ...scalingPolicies, cdn, dashboardRecord],
    }
  }
