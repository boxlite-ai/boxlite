/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import {
  assertHostIsAllowed,
  assertNotThroughRegistryProxy,
  catalogNameOf,
  imageRegistryAllowlist,
  isCuratedSelector,
  parseImageRef,
  proxyRefOf,
  upstreamRefOf,
} from './image-ref.util'

describe('image ref utilities', () => {
  const savedEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  describe('parseImageRef', () => {
    it.each([
      ['docker.io/library/python:3.12', 'docker.io', 'library/python', '3.12', undefined],
      ['python', 'docker.io', 'library/python', undefined, undefined],
      // Docker Hub's library namespace is implied by the host, not by leaving it out:
      // both spellings are one image, so they must be one catalog key.
      ['docker.io/python:3.12', 'docker.io', 'library/python', '3.12', undefined],
      ['127.0.0.1:25000/app', '127.0.0.1:25000', 'app', undefined, undefined],
      ['acme/app', 'docker.io', 'acme/app', undefined, undefined],
      ['ghcr.io/boxlite-ai/agent-base:v0.1.0', 'ghcr.io', 'boxlite-ai/agent-base', 'v0.1.0', undefined],
      ['127.0.0.1:25000/acme/app:v1', '127.0.0.1:25000', 'acme/app', 'v1', undefined],
      [`quay.io/acme/app@sha256:${'a'.repeat(64)}`, 'quay.io', 'acme/app', undefined, `sha256:${'a'.repeat(64)}`],
    ])('parses %s', (ref, host, repository, tag, digest) => {
      expect(parseImageRef(ref)).toEqual({ host, repository, tag, digest })
    })

    /**
     * Everything downstream — the catalog key, the `:idOrRef` route parameter,
     * the ref handed to a runner — is built from these parts, so a malformed
     * ref has to die here rather than somewhere that concatenates it.
     */
    it.each([
      ['empty', ''],
      ['leading whitespace', ' docker.io/acme/app'],
      ['path traversal', 'docker.io/../etc/passwd'],
      ['bare traversal segment', 'acme/../app'],
      ['empty segment', 'docker.io//app'],
      ['uppercase repository', 'docker.io/Acme/App'],
      ['illegal character', 'docker.io/acme/app$(whoami)'],
      ['short digest', 'docker.io/acme/app@sha256:deadbeef'],
      ['non-sha256 digest', `docker.io/acme/app@md5:${'a'.repeat(64)}`],
      ['invalid tag', 'docker.io/acme/app:-leading-dash'],
      ['overlong', `docker.io/acme/${'a'.repeat(600)}`],
    ])('rejects %s', (_label, ref) => {
      expect(() => parseImageRef(ref)).toThrow(BadRequestError)
    })
  })

  describe('host checks', () => {
    it('lists the allowed registries when refusing one', () => {
      const allowlist = ['docker.io', 'ghcr.io']
      expect(() => assertHostIsAllowed('evil.example', allowlist)).toThrow(/docker\.io, ghcr\.io/)
      expect(() => assertHostIsAllowed('ghcr.io', allowlist)).not.toThrow()
    })

    /**
     * These are refused because they are not on the list, like anything else
     * off it. What is asserted here is the message: a tenant who names the
     * metadata endpoint is told that is why, instead of being handed a registry
     * list and left to guess which entry to copy.
     */
    it.each(['169.254.169.254', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '[::1]', 'localhost'])(
      'refuses %s and says it resolves inside the deployment',
      (host) => {
        expect(() => assertHostIsAllowed(host, ['quay.io'])).toThrow(/resolves inside the deployment/)
      },
    )

    it('lets an operator name an internal host explicitly', () => {
      // The local stack points at a registry on the loopback. Deciding what
      // this deployment may reach is the operator's job, so the list wins.
      expect(() => assertHostIsAllowed('127.0.0.1:25000', ['127.0.0.1:25000'])).not.toThrow()
    })
  })

  describe('imageRegistryAllowlist', () => {
    it('falls back to the built-in registries when unset', () => {
      delete process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST
      // ghcr.io is absent on purpose; FALLBACK_ALLOWLIST says why.
      expect(imageRegistryAllowlist()).toEqual(['docker.io', 'quay.io', 'gcr.io', 'public.ecr.aws'])
    })

    it('takes the env list when set, so a registry can be added with no code change', () => {
      process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST = ' quay.io , 127.0.0.1:25000 '
      expect(imageRegistryAllowlist()).toEqual(['quay.io', '127.0.0.1:25000'])
    })
  })

  describe('selectors', () => {
    it.each([
      [undefined, true],
      ['base', true],
      ['python', true],
      ['ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0', true],
      ['docker.io/library/python:3.12', false],
      ['acme/app', false],
    ])('isCuratedSelector(%s) is %s', (image, expected) => {
      expect(isCuratedSelector(image as string | undefined)).toBe(expected)
    })
  })
  describe('registry proxy refs', () => {
    const PROXY = 'registry-proxy-abc.a.run.app'
    const ORG = '0aaa0000-0000-4000-8000-000000000001'

    beforeEach(() => {
      process.env.REGISTRY_PROXY_HOST = PROXY
    })

    it('spells the three ways to name one Docker Hub image as one path', () => {
      const refs = ['alpine:3.20', 'docker.io/alpine:3.20', 'library/alpine:3.20'].map((ref) =>
        proxyRefOf(PROXY, ORG, parseImageRef(ref)),
      )

      expect(new Set(refs)).toEqual(new Set([`${PROXY}/${ORG}/docker.io/library/alpine:3.20`]))
    })

    it('pins by digest when the ref does', () => {
      const digest = `sha256:${'a'.repeat(64)}`

      expect(proxyRefOf(PROXY, ORG, parseImageRef(`ghcr.io/acme/app@${digest}`))).toBe(
        `${PROXY}/${ORG}/ghcr.io/acme/app@${digest}`,
      )
    })

    it('reads a proxy ref back as the upstream ref it stands for', () => {
      const proxied = proxyRefOf(PROXY, ORG, parseImageRef('ghcr.io/acme/app:1.2'))

      expect(upstreamRefOf(proxied)).toBe('ghcr.io/acme/app:1.2')
      // So the catalog files it under the name the tenant uses, not the proxy.
      expect(catalogNameOf(proxied)).toBe('ghcr.io/acme/app')
    })

    it('leaves every other ref alone', () => {
      expect(upstreamRefOf('ghcr.io/acme/app:1.2')).toBe('ghcr.io/acme/app:1.2')
      delete process.env.REGISTRY_PROXY_HOST
      expect(upstreamRefOf(`${PROXY}/${ORG}/ghcr.io/acme/app:1.2`)).toBe(`${PROXY}/${ORG}/ghcr.io/acme/app:1.2`)
    })

    it('refuses a ref a tenant wrote against the proxy itself', () => {
      // Naming another organization in the path would borrow its login.
      expect(() => assertNotThroughRegistryProxy(parseImageRef(`${PROXY}/other-org/ghcr.io/x/y:1`).host)).toThrow(
        BadRequestError,
      )
      expect(() => assertNotThroughRegistryProxy('ghcr.io')).not.toThrow()
    })
  })
})
