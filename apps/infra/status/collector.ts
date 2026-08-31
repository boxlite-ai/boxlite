// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch'
import { DescribeInstancesCommand, DescribeInstanceStatusCommand, EC2Client } from '@aws-sdk/client-ec2'
import { DescribeServicesCommand, ECSClient, type Service } from '@aws-sdk/client-ecs'
import { DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2'
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
  type ResourceTagMapping,
} from '@aws-sdk/client-resource-groups-tagging-api'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import {
  buildPublicStatusSnapshot,
  RUNNER_HEARTBEAT_METRIC,
  RUNNER_HEARTBEAT_NAMESPACE,
  type EcsServiceObservation,
  type RegionObservation,
  type RunnerObservation,
} from './collector-core.js'

const STATUS_OBJECT_KEY = 'public-status.json'
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/
const RUNNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const STATUS_SERVICE_TAG = 'boxlite:status-service'
const STATUS_STAGE_TAG = 'boxlite:stage'
const RUNNER_ID_TAG = 'boxlite:control-plane-runner-name'

export interface CollectorConfig {
  bucketName: string
  stage: string
  regions: string[]
  runnerIds: string[]
}

export function requireCollectorConfig(environment = process.env): CollectorConfig {
  const bucketName = environment.STATUS_SNAPSHOT_BUCKET?.trim()
  const stage = environment.STATUS_STAGE?.trim()
  const regions = (environment.STATUS_REGIONS ?? '')
    .split(',')
    .map((region) => region.trim())
    .filter(Boolean)
  const runnerIds = (environment.STATUS_RUNNERS ?? '')
    .split(',')
    .map((runnerId) => runnerId.trim())
    .filter(Boolean)

  if (
    !bucketName ||
    !stage ||
    regions.length === 0 ||
    regions.some((region) => !AWS_REGION_PATTERN.test(region)) ||
    runnerIds.length === 0 ||
    runnerIds.some((runnerId) => !RUNNER_ID_PATTERN.test(runnerId))
  ) {
    throw new Error('STATUS_SNAPSHOT_BUCKET, STATUS_STAGE, valid STATUS_REGIONS, and valid STATUS_RUNNERS are required')
  }

  if (new Set(regions).size !== regions.length || new Set(runnerIds).size !== runnerIds.length) {
    throw new Error('STATUS_REGIONS and STATUS_RUNNERS must not contain duplicates')
  }

  return { bucketName, stage, regions, runnerIds }
}

function tagValue(mapping: ResourceTagMapping, key: string): string | undefined {
  return mapping.Tags?.find((tag) => tag.Key === key)?.Value
}

export function parseEcsServiceArn(serviceArn: string): { cluster: string; region: string } {
  const match = serviceArn.match(/^arn:[^:]+:ecs:([^:]+):[^:]+:service\/([^/]+)\/[^/]+$/)
  if (!match) {
    throw new Error('Tagged ECS service does not use a supported long ARN')
  }
  return { region: match[1], cluster: match[2] }
}

async function discoverEcsServices(region: string, stage: string): Promise<Map<'api' | 'proxy', ResourceTagMapping>> {
  const client = new ResourceGroupsTaggingAPIClient({ region })
  const mappings: ResourceTagMapping[] = []
  let paginationToken: string | undefined

  do {
    const page = await client.send(
      new GetResourcesCommand({
        PaginationToken: paginationToken,
        ResourceTypeFilters: ['ecs:service'],
        TagFilters: [{ Key: STATUS_STAGE_TAG, Values: [stage] }],
      }),
    )
    mappings.push(...(page.ResourceTagMappingList ?? []))
    paginationToken = page.PaginationToken || undefined
  } while (paginationToken)

  const services = new Map<'api' | 'proxy', ResourceTagMapping>()
  for (const mapping of mappings) {
    const role = tagValue(mapping, STATUS_SERVICE_TAG)
    if (role !== 'api' && role !== 'proxy') continue
    if (services.has(role)) {
      throw new Error(`Multiple tagged ${role} ECS services were found in ${region}`)
    }
    services.set(role, mapping)
  }
  return services
}

async function observeEcsService(
  region: string,
  mapping: ResourceTagMapping | undefined,
): Promise<EcsServiceObservation | undefined> {
  const serviceArn = mapping?.ResourceARN
  if (!serviceArn) return undefined

  const parsedArn = parseEcsServiceArn(serviceArn)
  if (parsedArn.region !== region) {
    throw new Error('Tagged ECS service belongs to a different region')
  }

  const ecs = new ECSClient({ region })
  const response = await ecs.send(new DescribeServicesCommand({ cluster: parsedArn.cluster, services: [serviceArn] }))
  if (response.failures?.length || response.services?.length !== 1) {
    throw new Error('Unable to describe a tagged ECS service')
  }

  const service = response.services[0] as Service
  const targetGroupArns = (service.loadBalancers ?? [])
    .map((loadBalancer) => loadBalancer.targetGroupArn)
    .filter((targetGroupArn): targetGroupArn is string => Boolean(targetGroupArn))
  if (targetGroupArns.length === 0) {
    throw new Error('Tagged public ECS service has no load balancer target group')
  }

  const elb = new ElasticLoadBalancingV2Client({ region })
  const targetHealth = (
    await Promise.all(
      targetGroupArns.map(async (targetGroupArn) => {
        const targets = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }))
        return (targets.TargetHealthDescriptions ?? []).map((target) =>
          target.TargetHealth?.State === 'healthy' ? ('healthy' as const) : ('unhealthy' as const),
        )
      }),
    )
  ).flat()

  return {
    isActive: service.status === 'ACTIVE',
    desiredCount: service.desiredCount ?? 0,
    runningCount: service.runningCount ?? 0,
    targetHealth,
  }
}

async function observeRunners(
  region: string,
  stage: string,
  expectedRunnerIds: string[],
  now: Date,
): Promise<RunnerObservation[]> {
  const ec2 = new EC2Client({ region })
  const instancesResponse = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${STATUS_STAGE_TAG}`, Values: [stage] },
        { Name: `tag:${STATUS_SERVICE_TAG}`, Values: ['runner'] },
        { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
      ],
    }),
  )
  const instances = (instancesResponse.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? [])
  const instanceIds = instances.map((instance) => instance.InstanceId).filter((id): id is string => Boolean(id))
  const statuses = instanceIds.length
    ? ((await ec2.send(new DescribeInstanceStatusCommand({ InstanceIds: instanceIds, IncludeAllInstances: true })))
        .InstanceStatuses ?? [])
    : []
  const statusByInstanceId = new Map(statuses.map((status) => [status.InstanceId, status]))

  const discoveredRunners = instances.map((instance) => {
    const id = instance.Tags?.find((tag) => tag.Key === RUNNER_ID_TAG)?.Value
    if (!id || !instance.InstanceId) {
      throw new Error('Tagged Runner instance is missing its public-status identity')
    }
    const status = statusByInstanceId.get(instance.InstanceId)
    return {
      id,
      isRunning: instance.State?.Name === 'running',
      instanceStatusPassed: status?.InstanceStatus?.Status === 'ok',
      systemStatusPassed: status?.SystemStatus?.Status === 'ok',
    }
  })

  if (new Set(discoveredRunners.map((runner) => runner.id)).size !== discoveredRunners.length) {
    throw new Error(`Duplicate Runner identities were found in ${region}`)
  }
  const expectedRunnerIdSet = new Set(expectedRunnerIds)
  if (discoveredRunners.some((runner) => !expectedRunnerIdSet.has(runner.id))) {
    throw new Error(`An unexpected tagged Runner identity was found in ${region}`)
  }
  const discoveredRunnerById = new Map(discoveredRunners.map((runner) => [runner.id, runner]))
  const runners = expectedRunnerIds.map(
    (id): RunnerObservation =>
      discoveredRunnerById.get(id) ?? {
        id,
        isRunning: false,
        instanceStatusPassed: false,
        systemStatusPassed: false,
      },
  )

  const cloudwatch = new CloudWatchClient({ region })
  const queries: MetricDataQuery[] = runners.map((runner, index) => ({
    Id: `runner${index}`,
    ReturnData: true,
    MetricStat: {
      Period: 60,
      Stat: 'Minimum',
      Metric: {
        Namespace: RUNNER_HEARTBEAT_NAMESPACE,
        MetricName: RUNNER_HEARTBEAT_METRIC,
        Dimensions: [
          { Name: 'Stage', Value: stage },
          { Name: 'Region', Value: region },
          { Name: 'Runner', Value: runner.id },
        ],
      },
    },
  }))
  const metrics = queries.length
    ? await cloudwatch.send(
        new GetMetricDataCommand({
          StartTime: new Date(now.getTime() - 5 * 60 * 1000),
          EndTime: now,
          ScanBy: 'TimestampDescending',
          MetricDataQueries: queries,
        }),
      )
    : undefined
  const metricById = new Map((metrics?.MetricDataResults ?? []).map((result) => [result.Id, result]))

  return runners.map((runner, index) => {
    const metric = metricById.get(`runner${index}`)
    const recordedAt = metric?.Timestamps?.[0]
    const value = metric?.Values?.[0]
    return {
      ...runner,
      ...(recordedAt && value !== undefined ? { heartbeat: { healthy: value >= 1, recordedAt } } : {}),
    }
  })
}

export async function collectRegion(
  region: string,
  stage: string,
  runnerIds: string[],
  now = new Date(),
): Promise<RegionObservation> {
  const services = await discoverEcsServices(region, stage)
  const [api, proxy, runners] = await Promise.all([
    observeEcsService(region, services.get('api')),
    observeEcsService(region, services.get('proxy')),
    observeRunners(region, stage, runnerIds, now),
  ])
  return { id: region, api, proxy, runners }
}

interface CollectorDependencies {
  collectRegion: typeof collectRegion
  putSnapshot: (bucketName: string, body: string) => Promise<void>
}

async function putSnapshot(bucketName: string, body: string): Promise<void> {
  const s3 = new S3Client({})
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: STATUS_OBJECT_KEY,
      Body: body,
      CacheControl: 'public,max-age=30,must-revalidate',
      ContentType: 'application/json; charset=utf-8',
      ServerSideEncryption: 'AES256',
    }),
  )
}

export async function collectAndPublish(
  config: CollectorConfig,
  now = new Date(),
  dependencies: CollectorDependencies = { collectRegion, putSnapshot },
): Promise<void> {
  const observations = await Promise.all(
    config.regions.map((region) => dependencies.collectRegion(region, config.stage, config.runnerIds, now)),
  )
  const snapshot = buildPublicStatusSnapshot(observations, now)
  await dependencies.putSnapshot(config.bucketName, JSON.stringify(snapshot))
}

export async function handler(): Promise<void> {
  const config = requireCollectorConfig()

  try {
    await collectAndPublish(config)
  } catch (error) {
    console.error('Public status collection failed; the last verified snapshot was preserved', {
      error: error instanceof Error ? error.name : 'UnknownError',
    })
    throw error
  }
}
