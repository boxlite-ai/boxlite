/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { EventEmitter } from 'node:events'
import axios from 'axios'
import { AuditService } from '../../audit/services/audit.service'
import { AuditLog } from '../../audit/entities/audit-log.entity'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxStateWaiterService } from '../../box/services/box-state-waiter.service'
import { BOX_EVENT_CHANNEL } from '../constants/constants'
import { NotificationService } from '../../notification/services/notification.service'
import { BoxStateUpdatedEvent } from '../../box/events/box-state-updated.event'
import { BoxService } from '../../box/services/box.service'
import { RunnerService } from '../../box/services/runner.service'
import { RunnerAdapterV2 } from '../../box/runner-adapter/runnerAdapter.v2'
import { BoxManager } from '../../box/managers/box.manager'
import { BoxStartAction } from '../../box/managers/box-actions/box-start.action'
import { BoxCreatedEvent } from '../../box/events/box-create.event'
import { JobService } from '../../box/services/job.service'
import { JobStateHandlerService } from '../../box/services/job-state-handler.service'
import { Job } from '../../box/entities/job.entity'
import { JobStatus } from '../../box/enums/job-status.enum'
import { JobType } from '../../box/enums/job-type.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'
import { CommerceBoxLimitService } from '../../boxlite-rest/commerce-box-limit.service'
import { SecretServerClient } from '../../box/services/secret-server-client'
import { FilestoreInstanceResolver } from '../../box/services/filestore-instance.resolver'
import { ImageAdmissionService } from '../../image/services/image-admission.service'
import { ImageResolverService } from '../../image/services/image-resolver.service'
import { VolumeService } from '../../box/services/volume.service'
import { VolumeState } from '../../box/enums/volume-state.enum'
import { SecretCredentialService } from '../../box/services/secret-credential.service'
import { CuratedImagePinService } from '../../image/services/curated-image-pin.service'

const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA)
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 })
const provider = new MeterProvider({ readers: [reader] })

async function histogramNames(): Promise<string[]> {
  await reader.forceFlush()
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .map((metric) => metric.descriptor.name)
}

async function expectHistograms(...names: string[]): Promise<void> {
  expect(await histogramNames()).toEqual(expect.arrayContaining(names))
}

async function histogramCount(name: string): Promise<number> {
  await reader.forceFlush()
  const points = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric): any[] => metric.dataPoints as any[]) as Array<{ value: { count?: number } }>
  return points.reduce<number>((count, point) => count + (point.value.count ?? 0), 0)
}

describe('create box instrumentation contracts', () => {
  beforeAll(() => metrics.setGlobalMeterProvider(provider))
  beforeEach(() => exporter.reset())
  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    await provider.shutdown()
    metrics.disable()
  })

  it('records the state wait, subscription and waiter DTO stages', async () => {
    const subscriber = new EventEmitter() as any
    subscriber.subscribe = jest.fn().mockResolvedValue(1)
    const boxService = {
      findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-1', state: BoxState.STARTING }),
      toBoxDto: jest.fn(async (box) => box),
    }
    const waiter = new BoxStateWaiterService(boxService as any, { duplicate: () => subscriber } as any)

    const waiting = waiter.waitForStarted('box-1', 'org-1', 5)
    await new Promise((resolve) => setImmediate(resolve))
    subscriber.emit('message', BOX_EVENT_CHANNEL, JSON.stringify({ box: { id: 'box-1', state: BoxState.STARTED } }))
    await waiting

    await expectHistograms('box_state_wait_duration', 'box_state_subscription_duration', 'box_state_wait_dto_duration')
  })

  it('times notification DTO and fire-and-forget publish independently', async () => {
    let finishPublish!: (value: number) => void
    const publishing = new Promise<number>((resolve) => (finishPublish = resolve))
    const notification = new NotificationService(
      { emitBoxStateUpdated: jest.fn() } as any,
      {} as any,
      { toBoxDto: jest.fn(async (box) => box) } as any,
      { publish: jest.fn(() => publishing) } as any,
    )
    const event = new BoxStateUpdatedEvent({ id: 'box-1' } as any, BoxState.CREATING, BoxState.STARTED)

    await notification.handleBoxStateUpdated(event)
    const beforePublish = await histogramNames()
    finishPublish(1)
    await publishing
    await new Promise(setImmediate)
    const afterPublish = await histogramNames()

    expect(beforePublish).toEqual(
      expect.arrayContaining(['box_state_notification_duration', 'box_state_notification_dto_duration']),
    )
    expect(beforePublish).not.toContain('box_state_notification_publish_duration')
    expect(afterPublish).toContain('box_state_notification_publish_duration')
  })

  it('records create orchestration, event and runner dispatch stages', async () => {
    const createContext = {
      organizationService: { isNestedVirtualizationEnabled: async () => false },
      getValidatedOrDefaultRegion: async () => {
        throw new Error('stop after admission starts')
      },
    }
    await expect(
      BoxService.prototype.create.call(
        createContext as any,
        {} as any,
        { id: 'org-1', boxLimitedNetworkEgress: false } as any,
        {} as any,
      ),
    ).rejects.toThrow('stop after admission starts')

    await (BoxService.prototype as any).persistOnAvailableRunner.call(
      { runnerService: { getRandomAvailableRunner: async () => ({ id: 'runner-1' }) } },
      { privileged: false },
      {},
      async () => ({ id: 'box-1' }),
    )
    await RunnerService.prototype.getRandomAvailableRunner.call({
      findAvailableRunners: async () => [{ id: 'runner-1' }],
    } as any)
    await expect(RunnerAdapterV2.prototype.createBox.call({} as any, { id: 'box-1' } as any, '')).rejects.toThrow(
      'has no image',
    )
    await (BoxManager.prototype as any).handleBoxCreatedEvent.call(
      { activeJobs: new Set(), syncInstanceState: async () => undefined },
      new BoxCreatedEvent({ id: 'box-1' } as any),
    )
    await (BoxStartAction.prototype as any).run.call(
      { logger: { error: jest.fn() } },
      { id: 'box-1', state: BoxState.ERROR },
      {},
    )

    await expectHistograms(
      'box_service_create_duration',
      'box_persist_available_runner_duration',
      'box_runner_select_duration',
      'box_runner_create_dispatch_duration',
      'box_created_event_duration',
      'box_start_action_duration',
    )
  })

  it('records job submission, status update and completion stages', async () => {
    const pending = new Job({
      id: 'job-1',
      type: JobType.CREATE_BOX,
      status: JobStatus.PENDING,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
    })
    const manager = {
      findOne: jest.fn().mockResolvedValue(pending),
      save: jest.fn(async (_entity, value) => value),
    }
    const jobs = new JobService(
      {
        insert: jest.fn().mockResolvedValue(undefined),
        manager: { transaction: jest.fn(async (operation) => operation(manager)) },
      } as any,
      { lpush: jest.fn().mockResolvedValue(1) } as any,
      { handleJobCompletion: jest.fn().mockResolvedValue(undefined) } as any,
    )
    await jobs.createJob(null, JobType.CREATE_BOX, 'runner-1', ResourceType.BOX, 'box-1', { image: 'base' })
    await jobs.updateJobStatus('job-1', JobStatus.IN_PROGRESS)

    const boxRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'box-1',
        organizationId: BOX_WARM_POOL_UNASSIGNED_ORGANIZATION,
        desiredState: BoxDesiredState.STARTED,
      }),
      update: jest.fn().mockResolvedValue(undefined),
    }
    const handler = new JobStateHandlerService(
      boxRepository as any,
      { unlock: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {} as any,
      {} as any,
    )
    await handler.handleJobCompletion(
      new Job({
        id: 'job-1',
        type: JobType.CREATE_BOX,
        status: JobStatus.COMPLETED,
        runnerId: 'runner-1',
        resourceType: ResourceType.BOX,
        resourceId: 'box-1',
      }),
    )

    await expectHistograms(
      'box_job_create_duration',
      'box_job_notify_duration',
      'box_job_status_update_duration',
      'box_create_job_completion_duration',
      'box_create_job_completion_update_duration',
    )
  })

  it('records Commerce cache/HTTP and Audit write boundaries', async () => {
    const config = {
      get: (key: string) =>
        ({
          billingApiUrl: 'https://commerce.test/api/billing',
          'usageExport.token': 'token',
        })[key],
    }
    const commerce = new CommerceBoxLimitService(
      config as any,
      { get: jest.fn().mockResolvedValue('limit:8'), set: jest.fn().mockResolvedValue('OK') } as any,
    )
    await expect(commerce.resolveMaxCreatedBoxes('org-1')).resolves.toBe(8)
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: [{ id: 'pro', concurrencyLimit: 8 }] })
      .mockResolvedValueOnce({ data: { plan: { planId: 'pro' } } })
    await (commerce as any).fetchMaxCreatedBoxes('org-1', 'https://commerce.test/api/billing', 'token')
    await (commerce as any).cacheResolvedLimit('cache-key', 8)

    const audit = new AuditService({} as never, { get: () => false } as never, {} as never, {} as never, {} as never)
    ;(audit as any).writeWithDeadline = jest
      .fn()
      .mockImplementationOnce(async (_timeout: number, operation: any) => operation({ insert: async () => undefined }))
      .mockResolvedValueOnce(new AuditLog({ actorId: 'actor', actorEmail: '', action: 'create' }))
    await audit.createLog({ actorId: 'actor', actorEmail: '', action: AuditAction.CREATE })
    await audit.updateLog('audit-1', {})

    await expectHistograms(
      'commerce_box_limit_resolve_duration',
      'commerce_box_limit_cache_read_duration',
      'commerce_box_limit_fetch_duration',
      'commerce_box_limit_cache_write_duration',
      'audit_create_duration',
      'audit_update_duration',
    )
  })

  it('records secret, Filestore, image, volume and credential boundaries', async () => {
    const secret = new SecretServerClient({
      get: (key: string) => ({ 'secretServer.url': 'https://secret.test', 'secretServer.devToken': undefined })[key],
    } as any)
    ;(secret as any).auth = {
      getIdTokenClient: async () => ({
        getRequestHeaders: async () => new Headers({ authorization: 'Bearer test' }),
      }),
    }
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          secrets: [{ name: 'first', secret_id: '11111111-1111-4111-8111-111111111111' }],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    )
    await (secret as any).transfer(
      'box-1',
      'org-1',
      'user-1',
      [{ name: 'first', value: 'value', hosts: [], headers: {} }],
      new AbortController().signal,
    )

    const filestore = new FilestoreInstanceResolver({} as any, () => ({
      getInstance: async () => [
        {
          state: 2,
          protocol: 2,
          networks: [{ ipAddresses: ['10.0.0.2'] }],
          fileShares: [{ name: 'share' }],
        },
      ],
    }))
    await (filestore as any).lookup('projects/p/locations/l/instances/i', 'configured', 'i')

    await ImageAdmissionService.prototype.assert.call({} as any, {} as any, 'base')
    await ImageResolverService.prototype.resolve.call({} as any, {} as any, 'base')

    const volume = { id: 'volume-1', name: 'data', state: VolumeState.READY }
    await VolumeService.prototype.validateVolumes.call(
      { volumeRepository: { find: jest.fn().mockResolvedValue([volume]) } } as any,
      'org-1',
      ['data'],
    )

    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'box-1' }])
        .mockResolvedValueOnce([{ expires_at: new Date('2026-11-26T00:00:00Z') }]),
    }
    await new SecretCredentialService({} as any).issue(
      { runnerId: 'runner-1', boxId: 'box-1', organizationId: 'org-1', secretIds: ['secret-1'] },
      manager as any,
    )
    await new CuratedImagePinService({ hget: jest.fn().mockResolvedValue(`sha256:${'a'.repeat(64)}`) } as any).refFor(
      'runner-1',
      'boxlite/base',
    )

    await expectHistograms(
      'secret_store_transfer_duration',
      'secret_store_auth_duration',
      'secret_store_http_duration',
      'filestore_lookup_duration',
      'image_admission_duration',
      'image_resolve_duration',
      'volume_validate_duration',
      'secret_credential_issue_duration',
      'image_curated_pin_duration',
    )
  })

  it('records credential issuance once when it opens its own transaction', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'box-1' }])
        .mockResolvedValueOnce([{ expires_at: new Date('2026-11-26T00:00:00Z') }]),
    }
    const service = new SecretCredentialService({
      transaction: jest.fn(async (operation) => operation(manager)),
    } as any)

    await service.issue({ runnerId: 'runner-1', boxId: 'box-1', organizationId: 'org-1', secretIds: ['secret-1'] })

    expect(await histogramCount('secret_credential_issue_duration')).toBe(1)
  })
})
