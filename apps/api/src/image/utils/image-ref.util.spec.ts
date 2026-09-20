/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import {
  assertHostIsAllowed,
  imageRegistryAllowlist,
  isCuratedSelector,
  parseImageRef,
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
      // docker.io and ghcr.io are absent on purpose: they are the two hosts
      // the runner holds operator credentials for, and a tenant ref on either
      // would be fetched with them until tenant pulls are made anonymous.
      expect(imageRegistryAllowlist()).toEqual(['quay.io', 'gcr.io', 'public.ecr.aws'])
    })

    it('takes the env list when set, so a registry can be added without a deploy', () => {
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
})
