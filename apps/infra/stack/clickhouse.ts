// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import type { FoundationResources } from './foundation.js'
import { RUNNER } from './settings.js'
import { requireClickHouseSecretArn, type ClickHouseConfig } from '../scripts/clickhouse-config.mjs'

export interface ManagedSecret {
  resource: aws.secretsmanager.Secret
  version: aws.secretsmanager.SecretVersion
}

export interface ClickHouseResources {
  url?: $util.Input<string>
  writerSecretArn?: $util.Input<string>
  readerSecretArn?: $util.Input<string>
  instanceId?: $util.Input<string>
  adminSecretArn?: $util.Input<string>
  ready?: command.local.Command
}

export async function buildClickHouseStorage(input: {
  foundation: FoundationResources
  region: string
  accountId: string
  config: ClickHouseConfig
  adminSecret?: ManagedSecret
  writerSecret?: ManagedSecret
  readerSecret?: ManagedSecret
}): Promise<ClickHouseResources> {
  const { foundation: { vpc }, region, accountId, config, adminSecret, writerSecret, readerSecret } = input

  if (config.mode === 'disabled') return {}
  if (config.mode === 'managed') {
    const managedSecretScope = { region, accountId, appName: $app.name, stage: $app.stage }
    return {
      url: config.url,
      writerSecretArn: requireClickHouseSecretArn(
        'CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN',
        config.writerSecretArn,
        managedSecretScope,
      ),
      readerSecretArn: requireClickHouseSecretArn(
        'CLICKHOUSE_READER_PASSWORD_SECRET_ARN',
        config.readerSecretArn,
        managedSecretScope,
      ),
    }
  }

  if (!adminSecret || !writerSecret || !readerSecret) {
    throw new Error('self-hosted ClickHouse secrets were not created')
  }
  const { encodeClickHouseUserData, CLICKHOUSE_IMAGE, renderClickHouseSchema } = await import(
    '../scripts/clickhouse-bootstrap.mjs'
  )

  const role = new aws.iam.Role('ClickHouseRole', {
    name: `${$app.name}-${$app.stage}-clickhouse-instance`,
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    }),
  })
  new aws.iam.RolePolicyAttachment('ClickHouseSsmPolicy', {
    role: role.name,
    policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  })
  const secretPolicy = new aws.iam.RolePolicy('ClickHouseSecretPolicy', {
    role: role.name,
    policy: $resolve([adminSecret.resource.arn, writerSecret.resource.arn, readerSecret.resource.arn]).apply(
      ([adminArn, writerArn, readerArn]) => JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [adminArn, writerArn, readerArn],
        }],
      }),
    ),
  })
  const profile = new aws.iam.InstanceProfile('ClickHouseProfile', {
    name: `${$app.name}-${$app.stage}-clickhouse-instance`,
    role: role.name,
  })
  const securityGroup = new aws.ec2.SecurityGroup('ClickHouseSecurityGroup', {
    vpcId: vpc.id,
    description: 'Private ClickHouse HTTP access from BoxLite services',
    ingress: [{
      protocol: 'tcp',
      fromPort: 8123,
      toPort: 8123,
      securityGroups: vpc.securityGroups,
    }],
    egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  })
  const subnet = aws.ec2.getSubnetOutput({ id: vpc.privateSubnets[0] })
  const volume = new aws.ebs.Volume(
    'ClickHouseData',
    {
      availabilityZone: subnet.availabilityZone,
      size: config.dataGiB,
      type: 'gp3',
      encrypted: true,
      tags: {
        Name: `${$app.name}-${$app.stage}-clickhouse-data`,
      },
    },
    { retainOnDelete: true },
  )
  const ami = aws.ec2.getAmiOutput({
    mostRecent: true,
    owners: [RUNNER.ubuntuOwnerId],
    filters: [
      { name: 'name', values: [RUNNER.ubuntuNamePattern] },
      { name: 'architecture', values: ['x86_64'] },
    ],
  })
  const userData = $resolve([
    volume.id,
    adminSecret.resource.arn,
    writerSecret.resource.arn,
    readerSecret.resource.arn,
  ]).apply(([volumeId, adminSecretArn, writerSecretArn, readerSecretArn]) =>
    encodeClickHouseUserData({
      region,
      volumeId,
      adminSecretArn,
      writerSecretArn,
      readerSecretArn,
      retentionHours: config.retentionHours,
    }),
  )
  const instance = new aws.ec2.Instance('ClickHouse', {
    ami: ami.id,
    instanceType: config.instanceType,
    subnetId: vpc.privateSubnets[0],
    associatePublicIpAddress: false,
    vpcSecurityGroupIds: [securityGroup.id],
    iamInstanceProfile: profile.name,
    metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
    userDataBase64: userData,
    userDataReplaceOnChange: true,
    rootBlockDevice: { encrypted: true, volumeType: 'gp3', volumeSize: 20 },
    tags: { Name: `${$app.name}-${$app.stage}-clickhouse` },
  }, {
    ignoreChanges: ['ami'],
    deleteBeforeReplace: true,
    dependsOn: [secretPolicy, adminSecret.version, writerSecret.version, readerSecret.version],
  })
  const attachment = new aws.ec2.VolumeAttachment('ClickHouseDataAttachment', {
    deviceName: '/dev/sdf',
    instanceId: instance.id,
    volumeId: volume.id,
    stopInstanceBeforeDetaching: true,
  }, { deleteBeforeReplace: true })
  const ready = new command.local.Command('ClickHouseDatabaseReady', {
    dir: $cli.paths.root,
    create: 'node scripts/clickhouse-readiness.mjs',
    update: 'node scripts/clickhouse-readiness.mjs',
    environment: {
      AWS_REGION: region,
      CLICKHOUSE_INSTANCE_ID: instance.id,
      CLICKHOUSE_ADMIN_SECRET_ARN: adminSecret.resource.arn,
      CLICKHOUSE_WRITER_SECRET_ARN: writerSecret.resource.arn,
      CLICKHOUSE_READER_SECRET_ARN: readerSecret.resource.arn,
      CLICKHOUSE_EXPECTED_IMAGE: CLICKHOUSE_IMAGE,
      CLICKHOUSE_SCHEMA_BASE64: Buffer.from(renderClickHouseSchema(config.retentionHours)).toString('base64'),
      CLICKHOUSE_RETENTION_HOURS: String(config.retentionHours),
    },
    triggers: [instance.id, volume.id, userData, adminSecret.version.id, writerSecret.version.id, readerSecret.version.id],
  }, { dependsOn: [attachment] })
  return {
    url: $interpolate`http://${instance.privateIp}:8123`,
    writerSecretArn: writerSecret.resource.arn,
    readerSecretArn: readerSecret.resource.arn,
    instanceId: instance.id,
    adminSecretArn: adminSecret.resource.arn,
    ready,
  }
}

export function buildClickHouseWriterReady(input: {
  region: string
  config: ClickHouseConfig
  resources: ClickHouseResources
  otelCollector: any
  otelCollectorOtlpHttpUrl: $util.Output<string>
}): any {
  const { region, config, resources, otelCollector, otelCollectorOtlpHttpUrl } = input
  if (!config.active) return undefined
  if (config.mode !== 'self-hosted') return otelCollector
  if (!resources.instanceId || !resources.adminSecretArn) return resources.ready
  return new command.local.Command('ClickHouseWriterReady', {
    dir: $cli.paths.root,
    create: 'node scripts/clickhouse-writer-ready.mjs',
    update: 'node scripts/clickhouse-writer-ready.mjs',
    environment: {
      AWS_REGION: region,
      CLICKHOUSE_INSTANCE_ID: resources.instanceId,
      CLICKHOUSE_ADMIN_SECRET_ARN: resources.adminSecretArn,
      OTEL_COLLECTOR_ENDPOINT: otelCollectorOtlpHttpUrl,
    },
    triggers: [resources.instanceId, otelCollectorOtlpHttpUrl, otelCollector.nodes.taskDefinition.arn],
  }, { dependsOn: [otelCollector] })
}
