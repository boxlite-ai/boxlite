/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { Test, TestingModule } from '@nestjs/testing'
import { logs } from '@opentelemetry/api-logs'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { LoggerModule, Logger as PinoLogger } from 'nestjs-pino'
import { swapMessageAndObject } from '../../common/utils/pino.util'
import { Job } from '../../box/entities/job.entity'
import { JobStatus } from '../../box/enums/job-status.enum'
import { JobType } from '../../box/enums/job-type.enum'
import { ResourceType } from '../../box/enums/resource-type.enum'
import { recordBoxJobOutcome } from '../../box/utils/box-business-event.util'
import { TypedConfigService } from '../../config/typed-config.service'
import { grantedAnalyticsConsent } from '../../../test/granted-analytics-consent'
import { AnalyticsService } from './analytics.service'

// Apply the production instrumentation hook inside Jest's module registry.
jest.mock('pino', () => {
  const { PinoInstrumentation } = jest.requireActual('@opentelemetry/instrumentation-pino')
  const [definition] = new PinoInstrumentation().getModuleDefinitions()
  return definition.patch(jest.requireActual('pino'), jest.requireActual('pino/package.json').version)
})

it('delivers historical job identity and occurrence time through real PostHog HTTP and OTLP logging', async () => {
  type Captured = {
    event: string
    uuid: string
    distinct_id: string
    timestamp: string
    properties: Record<string, unknown>
  }
  const received: Captured[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      received.push(...JSON.parse(Buffer.concat(chunks).toString()).batch)
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":1}')
    })
  })
  const exporter = new InMemoryLogRecordExporter()
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] })
  let app: TestingModule | undefined
  let analytics: AnalyticsService | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    logs.setGlobalLoggerProvider(provider)
    app = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({
          pinoHttp: [
            { level: 'info', hooks: { logMethod: swapMessageAndObject } },
            new Writable({ write: (_chunk, _encoding, done) => done() }),
          ],
        }),
      ],
    }).compile()
    app.useLogger(app.get(PinoLogger))
    const config: Record<string, string> = {
      'posthog.apiKey': 'phc_test',
      'posthog.host': 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
      'posthog.environment': 'test',
    }
    analytics = new AnalyticsService(
      { get: (key: string) => config[key] } as TypedConfigService,
      grantedAnalyticsConsent,
    )
    const job = new Job({
      id: 'job-1',
      type: JobType.START_BOX,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: 'box-1',
      completedAt: new Date('2020-01-01T00:00:03Z'),
    })
    job.createdAt = new Date('2020-01-01T00:00:00Z')
    const box = { id: job.resourceId, organizationId: 'org-1', imageIsOrgOwned: true }
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
    await analytics.onApplicationShutdown()
    analytics = undefined

    const exported = exporter.getFinishedLogRecords().filter((record) => record.body === 'box.start success')
    const features = received.filter((event) => event.event === 'cloud.feature.use')
    const featureLogs = exporter.getFinishedLogRecords().filter((record) => record.body === 'cloud.feature.use success')
    expect(features).toHaveLength(2)
    expect(featureLogs).toHaveLength(2)
    expect(features[0].uuid).toBe(features[1].uuid)
    for (const [index, event] of features.entries()) {
      expect(event.uuid).toBe(featureLogs[index].attributes['event.id'])
      expect(event.timestamp).toBe(job.completedAt!.toISOString())
      expect(event.properties).toMatchObject({
        cloud_metrics_schema: '1',
        'feature.name': 'custom_image',
        'feature.evidence': 'started_image',
        $groups: { organization: box.organizationId },
      })
      expect(event.properties).not.toHaveProperty('activity_schema')
    }
    const captured = received.filter((event) => event.event === 'box.start')
    expect(exported).toHaveLength(2)
    expect(captured).toHaveLength(2)
    expect(captured[0].uuid).toEqual(expect.any(String))
    expect(captured[1].uuid).toBe(captured[0].uuid)
    for (const [index, event] of captured.entries()) {
      expect(event.uuid).toBe(exported[index].attributes['event.id'])
      expect(event.distinct_id).toBe('anonymous:box-1')
      expect(event.timestamp).toBe(job.completedAt!.toISOString())
      expect(event.properties).toMatchObject({
        'event.id': exported[index].attributes['event.id'],
        'event.timestamp': job.completedAt!.toISOString(),
        'job.id': job.id,
        'job.duration_ms': '3000',
        $groups: { organization: box.organizationId },
        $process_person_profile: false,
      })
      expect(exported[index].attributes['event.timestamp']).toBe(event.timestamp)
      expect(exported[index].hrTime[0]).toBeGreaterThan(job.completedAt!.getTime() / 1000)
    }
  } finally {
    await analytics?.onApplicationShutdown()
    await app?.close()
    await provider.shutdown()
    logs.disable()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
