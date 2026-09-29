/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { sanitizeBoxError } from './sanitize-error.util'

describe('sanitizeBoxError', () => {
  const PROXY = 'registry-proxy-abc.a.run.app'
  const ORG = '0aaa0000-0000-4000-8000-000000000001'

  // The shape the runtime reports a pull through the registry proxy failing
  // in: the ref it was handed, and the request URL its registry client adds.
  const failedPull = (proxied: string, url: string) =>
    `Failed to pull image '${proxied}' after trying 1 registry:\n` +
    `  - ${proxied}: failed to pull manifest: Registry error: url ${url}, ` +
    `envelope: upstream ghcr.io refused the organization's registry credential`

  afterEach(() => {
    delete process.env.REGISTRY_PROXY_HOST
  })

  // The tenant named ghcr.io/acme/app:1 and reads that back as the box's
  // image; the reason its box failed has to name the same image, not the
  // proxy's address and the organization segment the resolver put in front.
  it('names the upstream image in a failed private pull, not the registry proxy', () => {
    process.env.REGISTRY_PROXY_HOST = PROXY

    const { errorReason } = sanitizeBoxError(
      failedPull(`${PROXY}/${ORG}/ghcr.io/acme/app:1`, `https://${PROXY}/v2/${ORG}/ghcr.io/acme/app/manifests/1`),
    )

    expect(errorReason).toBe(failedPull('ghcr.io/acme/app:1', 'https://ghcr.io/v2/acme/app/manifests/1'))
  })

  // Before any manifest, the registry client asks the proxy's /v2/ for its
  // authentication challenge, and an unreachable proxy fails that request by
  // its URL. That URL names no image, and the fault is the proxy's rather than
  // ghcr.io's, so it reads as the proxy without its address.
  it('names an unreachable registry proxy without its address', () => {
    process.env.REGISTRY_PROXY_HOST = PROXY
    const unreachable = (proxied: string, url: string) =>
      `Failed to pull image '${proxied}' after trying 1 registry:\n` +
      `  - ${proxied}: failed to pull a registry token: error sending request for url (${url})`

    const { errorReason } = sanitizeBoxError(unreachable(`${PROXY}/${ORG}/ghcr.io/acme/app:1`, `https://${PROXY}/v2/`))

    expect(errorReason).toBe(unreachable('ghcr.io/acme/app:1', 'the registry proxy'))
  })

  // A runner wraps a reason it thinks recoverable in JSON; the reason inside
  // reaches the tenant just the same.
  it('names the upstream image inside a recoverable error too', () => {
    process.env.REGISTRY_PROXY_HOST = PROXY

    const reported = JSON.stringify({
      recoverable: true,
      errorReason: `pulling ${PROXY}/${ORG}/docker.io/library/alpine:3.20: no space left on device`,
    })

    expect(sanitizeBoxError(reported)).toEqual({
      recoverable: true,
      errorReason: 'pulling docker.io/library/alpine:3.20: no space left on device',
    })
  })

  it('leaves a reason that names no registry proxy as it was', () => {
    process.env.REGISTRY_PROXY_HOST = PROXY
    const direct = failedPull('quay.io/acme/app:1', 'https://quay.io/v2/acme/app/manifests/1')

    expect(sanitizeBoxError(new Error(direct)).errorReason).toBe(direct)
  })
})
