/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Writable } from 'stream'
import { Test, TestingModule } from '@nestjs/testing'
import { logs } from '@opentelemetry/api-logs'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { LoggerModule, Logger as PinoLogger } from 'nestjs-pino'
import { swapMessageAndObject } from './pino.util'
import { recordBusinessEvent } from './business-event.util'

// Jest loads modules through its own registry, so PinoInstrumentation's require
// hook never fires here. Apply the same patch tracing.ts installs, by hand, so
// the pino that nestjs-pino (via pino-http) builds sends to OpenTelemetry the
// way it does in the running API.
jest.mock('pino', () => {
  const { PinoInstrumentation } = jest.requireActual('@opentelemetry/instrumentation-pino')
  const [pinoDefinition] = new PinoInstrumentation().getModuleDefinitions()
  return pinoDefinition.patch(jest.requireActual('pino'), jest.requireActual('pino/package.json').version)
})

describe('recordBusinessEvent through the API logging stack', () => {
  const exporter = new InMemoryLogRecordExporter()
  let app: TestingModule

  beforeAll(async () => {
    logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] }))

    const discardConsole = new Writable({ write: (_chunk, _encoding, done) => done() })
    app = await Test.createTestingModule({
      // The same hook app.module.ts installs; it is what turns the event object into pino fields.
      imports: [
        LoggerModule.forRoot({
          pinoHttp: [{ level: 'info', hooks: { logMethod: swapMessageAndObject } }, discardConsole],
        }),
      ],
    }).compile()
    app.useLogger(app.get(PinoLogger))
  })

  afterAll(async () => {
    await app.close()
    logs.disable()
  })

  it('exports the event attributes as top-level OTLP log attributes', () => {
    recordBusinessEvent({
      name: 'box.delete',
      outcome: 'requested',
      correlationId: 'box-1',
      orgId: 'org-1',
      actorKind: 'auto_delete',
    })

    const record = exporter.getFinishedLogRecords().find((log) => log.body === 'box.delete requested')
    expect(record?.attributes).toEqual(
      expect.objectContaining({
        'event.name': 'box.delete',
        'event.outcome': 'requested',
        'correlation.id': 'box-1',
        'org.id': 'org-1',
        'actor.kind': 'auto_delete',
        'service.type': 'api',
      }),
    )
    expect(record?.attributes['event.timestamp']).toEqual(expect.any(String))
  })
})
