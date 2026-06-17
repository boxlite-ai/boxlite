/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus } from '@nestjs/common'
import { RunnerApiError } from './runner-api-error'
import { sanitizedNonJsonRunnerMessage } from '../runner-adapter/runnerAdapter.v0'

describe('RunnerApiError', () => {
  it('maps runner 5xx errors to API 502 JSON errors', () => {
    const error = new RunnerApiError('Runner API returned a non-JSON error response', 503, 'runner_non_json_error')

    expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY)
    expect(error.getResponse()).toEqual({
      statusCode: HttpStatus.BAD_GATEWAY,
      message: 'Runner API returned a non-JSON error response',
      code: 'runner_non_json_error',
    })
    expect(error.runnerStatusCode).toBe(503)
    expect(error.statusCode).toBe(503)
  })

  it('preserves runner 4xx status codes for caller-correctable failures', () => {
    const error = new RunnerApiError('Unsupported image', 422, 'unsupported_image')

    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(error.getResponse()).toEqual({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Unsupported image',
      code: 'unsupported_image',
    })
    expect(error.runnerStatusCode).toBe(422)
    expect(error.statusCode).toBe(422)
  })

  it('keeps the legacy statusCode field for manager cleanup paths', () => {
    const error = new RunnerApiError('not found', 404, 'not_found')

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND)
    expect(error.statusCode).toBe(404)
  })

  it('embeds a sanitized non-JSON runner response excerpt', () => {
    const message = sanitizedNonJsonRunnerMessage(`
      <html>
        <head><style>.hidden { display: none }</style></head>
        <body>
          <h1>502 Bad Gateway</h1>
          <script >window.secret = "do-not-include"</script >
          upstream connect error or disconnect/reset before headers. token=secret-value
        </body>
      </html>
    `)

    expect(message).toContain('502 Bad Gateway')
    expect(message).toContain('upstream connect error')
    expect(message).toContain('token=[redacted]')
    expect(message).not.toContain('<html>')
    expect(message).not.toContain('do-not-include')
  })
})
