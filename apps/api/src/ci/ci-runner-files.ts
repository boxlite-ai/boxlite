/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BadGatewayException } from '@nestjs/common'
import { jitFileArchive } from '@boxlite-ai/ci-listener'

/** Fixed single-file archives only; no user paths, archive parsing or disk staging. */
export async function uploadJitFile(
  endpoint: string,
  key: string,
  boxId: string,
  file: '.boxlite-jitconfig' | '.boxlite-jitconfig.ready',
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !key)
      throw new Error('Invalid runner connection')
    url.pathname = `/v1/boxes/${encodeURIComponent(boxId)}/files`
    url.search = '?path=%2Fhome%2Frunner'
    url.hash = ''
    const archive = jitFileArchive(file, content)
    const deadline = AbortSignal.timeout(30_000)
    const response = await fetch(url, {
      method: 'PUT',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-tar',
        'Content-Length': String(archive.length),
      },
      body: new Uint8Array(archive),
    })
    // Do not buffer an upstream error body or carry credentials into exceptions.
    await response.body?.cancel()
    if (response.status !== 204) throw new Error('JIT upload not acknowledged')
  } catch {
    // An upstream 404 is not proof that the platform-owned Box is absent.
    throw new BadGatewayException('CI JIT delivery failed; original Box requires reconciliation')
  }
}
