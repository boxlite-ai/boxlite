/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { pullFailureOf } from './pull-failure.util'

/** A runner's pull error as the runtime words it, one line per registry tried. */
const failedPull = (...lines: string[]) =>
  `storage error: Failed to pull image 'ghcr.io/acme/app@sha256:${'a'.repeat(64)}' after trying ${lines.length} registry:\n` +
  lines.map((line) => `  - ghcr.io/acme/app: storage error: ${line}`).join('\n')

describe('pullFailureOf', () => {
  it.each(['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'])('reads %s as an image its registry does not have', (code) => {
    const reason = failedPull(
      `failed to pull manifest [${code}]: Registry error: url https://ghcr.io/v2/acme/app/manifests/sha256:x, envelope: OCI API errors: [OCI API error: manifest unknown]`,
    )

    expect(pullFailureOf(reason)).toEqual({ kind: 'missing', codes: [code] })
  })

  it.each([
    ['manifest', 'DENIED'],
    ['manifest', 'UNAUTHORIZED'],
    ['a registry token', 'UNAUTHORIZED'],
  ])('reads a %s refused with %s as a refusal, never as a missing image', (what, code) => {
    const reason = failedPull(`failed to pull ${what} [${code}]: Not authorized: url https://ghcr.io/v2/`)

    expect(pullFailureOf(reason)).toEqual({ kind: 'refused', codes: [code] })
  })

  /**
   * The wording is each registry's own, and the runtime that stops sending
   * codes is still in service until every runner is upgraded. Neither may be
   * read as a verdict.
   */
  it.each([
    ['a runtime that sends no codes', 'failed to pull manifest: Registry error: manifest unknown'],
    ['a bare status', 'failed to pull manifest: Server error: url https://quay.io/v2/, code: 404, message: '],
    ['a code a caller cannot act on', 'failed to pull layer sha256:b [BLOB_UNKNOWN]: blob unknown'],
    ['a connection that never reached the registry', 'failed to pull manifest: error sending request'],
  ])('leaves %s unread', (_what, line) => {
    expect(pullFailureOf(failedPull(line))).toBeUndefined()
  })

  it('leaves two registries that disagree unread', () => {
    const reason = failedPull(
      'failed to pull manifest [MANIFEST_UNKNOWN]: manifest unknown',
      'failed to pull manifest [DENIED]: denied',
    )

    expect(pullFailureOf(reason)).toBeUndefined()
  })

  it('does not take a bracketed word elsewhere in the message for a code', () => {
    expect(pullFailureOf('box failed to start: see [MANIFEST_UNKNOWN] in the docs')).toBeUndefined()
  })

  it('reads a message that repeats `failed to pull ` in linear time', () => {
    const reason = 'failed to pull '.repeat(40_000)
    const started = performance.now()

    expect(pullFailureOf(reason)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
