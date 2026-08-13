// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

export interface FoundationResources {
  vpc: InstanceType<typeof sst.aws.Vpc>
  db: InstanceType<typeof sst.aws.Postgres>
  redis: InstanceType<typeof sst.aws.Redis>
  storage: InstanceType<typeof sst.aws.Bucket>
  cluster: InstanceType<typeof sst.aws.Cluster>
}

export function createFoundation(region: string, isProd: boolean): FoundationResources {
  const vpc = new sst.aws.Vpc('Vpc', {
    nat: 'ec2',
    transform: {
      natInstance: (args: any, _opts: any, resourceName: any) => {
        const index = resourceName.match(/\d+$/)?.[0] ?? ''
        const availabilityZone = aws.ec2.getSubnetOutput({ id: args.subnetId }).availabilityZone
        args.tags = {
          ...args.tags,
          Name: $interpolate`${$app.name}-${$app.stage}-nat-${index}-${availabilityZone}`,
        }
      },
      elasticIp: (args: any, _opts: any, resourceName: any) => {
        const index = resourceName.match(/\d+$/)?.[0] ?? ''
        args.tags = { ...args.tags, Name: `${$app.name}-${$app.stage}-nat-eip-${index}` }
      },
      natSecurityGroup: (args: any) => {
        args.tags = { ...args.tags, Name: `${$app.name}-${$app.stage}-nat-sg` }
      },
    },
  })

  const dbFinalSnapshotId = isProd ? new random.RandomId('DbFinalSnapshotSuffix', { byteLength: 4 }) : undefined
  const db = new sst.aws.Postgres('Database', {
    vpc,
    instance: 't4g.micro',
    storage: '20 GB',
    transform: {
      instance: (args: any) => {
        args.deletionProtection = isProd
        args.skipFinalSnapshot = !isProd
        if (dbFinalSnapshotId) {
          args.finalSnapshotIdentifier = $interpolate`${$app.name}-${$app.stage}-db-final-${dbFinalSnapshotId.hex}`
        }
      },
    },
  })
  const redis = new sst.aws.Redis('Cache', { vpc, cluster: false })
  const storage = new sst.aws.Bucket('Storage', { versioning: true })
  const cluster = new sst.aws.Cluster('Cluster', {
    forceUpgrade: 'v2',
    vpc: {
      id: vpc.id,
      securityGroups: vpc.securityGroups,
      containerSubnets: vpc.privateSubnets,
      loadBalancerSubnets: vpc.publicSubnets,
      cloudmapNamespaceId: vpc.nodes.cloudmapNamespace.id,
      cloudmapNamespaceName: vpc.nodes.cloudmapNamespace.name,
    },
  })

  new aws.ec2.VpcEndpoint('S3Gateway', {
    vpcId: vpc.nodes.vpc.id,
    serviceName: `com.amazonaws.${region}.s3`,
    vpcEndpointType: 'Gateway',
    routeTableIds: vpc.nodes.privateRouteTables.apply((tables: any) => tables.map((table: any) => table.id)),
  })

  return { vpc, db, redis, storage, cluster }
}
