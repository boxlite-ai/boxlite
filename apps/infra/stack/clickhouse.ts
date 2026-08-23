// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

import type { FoundationResources } from './foundation.js'
import { RUNNER } from './settings.js'
import { requireClickHouseSecretArn, resolveClickHouseConfig } from '../deployment/clickhouse.js'

const CLICKHOUSE_INSTANCE_TYPE = 'm6a.large'
const CLICKHOUSE_DATA_GIB = 50
export const CLICKHOUSE_DATABASE = 'otel'
export const CLICKHOUSE_WRITER_USERNAME = 'otel_writer'
export const CLICKHOUSE_READER_USERNAME = 'otel_reader'

interface ManagedSecret {
  resource: aws.secretsmanager.Secret
  version: aws.secretsmanager.SecretVersion
}

interface DisabledClickHouseResources {
  mode: 'disabled'
  active: false
}

interface ManagedClickHouseResources {
  mode: 'managed'
  active: true
  url: $util.Input<string>
  writerSecretArn: $util.Input<string>
  writerSecretVersionId: $util.Input<string>
  readerSecretArn: $util.Input<string>
  readerSecretVersionId: $util.Input<string>
}

interface SelfHostedClickHouseResources {
  mode: 'self-hosted'
  active: true
  url: $util.Input<string>
  writerSecretArn: $util.Input<string>
  writerSecretVersionId: $util.Input<string>
  readerSecretArn: $util.Input<string>
  readerSecretVersionId: $util.Input<string>
  instanceId: $util.Input<string>
  adminSecretArn: $util.Input<string>
  ready: command.local.Command
}

export type ClickHouseResources =
  | DisabledClickHouseResources
  | ManagedClickHouseResources
  | SelfHostedClickHouseResources

function createClickHouseSecret(resourceName: string, name: string) {
  const password = new random.RandomPassword(resourceName.replace(/Secret$/, 'Password'), { length: 32, special: false })
  const resource = new aws.secretsmanager.Secret(resourceName, {
    namePrefix: `${$app.name}-${$app.stage}-${name}-`,
    recoveryWindowInDays: 7,
  })
  const version = new aws.secretsmanager.SecretVersion(`${resourceName}Value`, {
    secretId: resource.id,
    secretString: $util.secret(password.result),
  })
  return { resource, version }
}

function currentSecretVersionId(name: string, secretId: string, region: string) {
  return aws.secretsmanager.getSecretVersionsOutput({ secretId, region }).versions.apply((versions) => {
    const current = versions.filter((version) => version.versionStages.includes('AWSCURRENT'))
    if (current.length !== 1) throw new Error(`${name} must have exactly one AWSCURRENT version`)
    return current[0].versionId
  })
}

export async function buildClickHouseStorage(input: {
  foundation: FoundationResources
  region: string
  accountId: string
}): Promise<ClickHouseResources> {
  const { foundation: { vpc }, region, accountId } = input
  const config = resolveClickHouseConfig(process.env)

  if (config.mode === 'disabled') return { mode: config.mode, active: false }
  if (config.mode === 'managed') {
    const managedSecretScope = { region, accountId, appName: $app.name, stage: $app.stage }
    const writerSecretArn = requireClickHouseSecretArn(
      'CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN',
      config.writerSecretArn,
      managedSecretScope,
    )
    const readerSecretArn = requireClickHouseSecretArn(
      'CLICKHOUSE_READER_PASSWORD_SECRET_ARN',
      config.readerSecretArn,
      managedSecretScope,
    )
    return {
      mode: config.mode,
      active: true,
      url: config.url,
      writerSecretArn,
      writerSecretVersionId: currentSecretVersionId(
        'CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN',
        writerSecretArn,
        region,
      ),
      readerSecretArn,
      readerSecretVersionId: currentSecretVersionId(
        'CLICKHOUSE_READER_PASSWORD_SECRET_ARN',
        readerSecretArn,
        region,
      ),
    }
  }

  const adminSecret: ManagedSecret = createClickHouseSecret('ClickHouseAdminSecret', 'clickhouse-admin')
  const writerSecret: ManagedSecret = createClickHouseSecret('ClickHouseWriterSecret', 'clickhouse-writer')
  const readerSecret: ManagedSecret = createClickHouseSecret('ClickHouseReaderSecret', 'clickhouse-reader')
  const { encodeClickHouseUserData, CLICKHOUSE_IMAGE, CLICKHOUSE_RETENTION_HOURS, renderClickHouseSchema } = await import(
    '../scripts/clickhouse-host.js'
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
      size: CLICKHOUSE_DATA_GIB,
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
    }),
  )
  const instance = new aws.ec2.Instance('ClickHouse', {
    ami: ami.id,
    instanceType: CLICKHOUSE_INSTANCE_TYPE,
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
    create: 'node scripts/clickhouse-ops.mjs reconcile',
    update: 'node scripts/clickhouse-ops.mjs reconcile',
    environment: {
      AWS_REGION: region,
      CLICKHOUSE_INSTANCE_ID: instance.id,
      CLICKHOUSE_ADMIN_SECRET_ARN: adminSecret.resource.arn,
      CLICKHOUSE_WRITER_SECRET_ARN: writerSecret.resource.arn,
      CLICKHOUSE_READER_SECRET_ARN: readerSecret.resource.arn,
      CLICKHOUSE_EXPECTED_IMAGE: CLICKHOUSE_IMAGE,
      CLICKHOUSE_SCHEMA_BASE64: Buffer.from(renderClickHouseSchema()).toString('base64'),
      CLICKHOUSE_RETENTION_HOURS: String(CLICKHOUSE_RETENTION_HOURS),
    },
    triggers: [instance.id, volume.id, userData, adminSecret.version.id, writerSecret.version.id, readerSecret.version.id],
  }, { dependsOn: [attachment] })
  return {
    mode: config.mode,
    active: true,
    url: $interpolate`http://${instance.privateIp}:8123`,
    writerSecretArn: writerSecret.resource.arn,
    writerSecretVersionId: writerSecret.version.versionId,
    readerSecretArn: readerSecret.resource.arn,
    readerSecretVersionId: readerSecret.version.versionId,
    instanceId: instance.id,
    adminSecretArn: adminSecret.resource.arn,
    ready,
  }
}

export function buildClickHouseWriterReady(input: {
  region: string
  resources: ClickHouseResources
  otelCollector: any
  otelCollectorOtlpHttpUrl: $util.Output<string>
  verificationTrigger: string
}): any {
  const { region, resources, otelCollector, otelCollectorOtlpHttpUrl } = input
  if (resources.mode === 'disabled') return undefined
  if (resources.mode === 'managed') return otelCollector
  return new command.local.Command('ClickHouseWriterReady', {
    dir: $cli.paths.root,
    create: 'node scripts/clickhouse-ops.mjs smoke',
    update: 'node scripts/clickhouse-ops.mjs smoke',
    environment: {
      AWS_REGION: region,
      CLICKHOUSE_INSTANCE_ID: resources.instanceId,
      CLICKHOUSE_READER_SECRET_ARN: resources.readerSecretArn,
      OTEL_COLLECTOR_ENDPOINT: otelCollectorOtlpHttpUrl,
    },
    triggers: [
      resources.instanceId,
      resources.readerSecretVersionId,
      otelCollectorOtlpHttpUrl,
      otelCollector.nodes.taskDefinition.arn,
      input.verificationTrigger,
    ],
  }, { dependsOn: [otelCollector] })
}
