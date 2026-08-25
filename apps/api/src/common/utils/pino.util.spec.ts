/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Writable } from 'node:stream'
import pino from 'pino'
import { PINO_HTTP_REDACT } from './pino.util'

describe('Pino request redaction', () => {
  it('removes bearer credentials while retaining non-sensitive request context', async () => {
    const token = 'synthetic-log-redaction-workload-token'
    let output = ''
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    const logger = pino({ redact: PINO_HTTP_REDACT }, destination)

    logger.info({ req: { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } } })
    await new Promise((resolve) => setImmediate(resolve))

    expect(output).not.toContain(token)
    expect(JSON.parse(output)).toMatchObject({
      req: {
        method: 'GET',
        headers: {
          authorization: '[REDACTED]',
          accept: 'application/json',
        },
      },
    })
  })
})
