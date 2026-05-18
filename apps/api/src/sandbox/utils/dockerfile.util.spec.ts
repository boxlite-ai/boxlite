/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { parseDockerfileForSingleFromRef } from './dockerfile.util'

// 64-hex sha256 used in place of the toy `abcd` in earlier fixtures so the
// test ref matches the shape `validateImageName` enforces in snapshot.service.
const SAMPLE_DIGEST = 'a'.repeat(64)

describe('parseDockerfileForSingleFromRef', () => {
  describe('matches single-FROM dockerfiles', () => {
    it('extracts a simple image ref', () => {
      expect(parseDockerfileForSingleFromRef('FROM alpine:3.22.4\n')).toBe('alpine:3.22.4')
    })

    it('handles missing trailing newline', () => {
      expect(parseDockerfileForSingleFromRef('FROM alpine:3.22.4')).toBe('alpine:3.22.4')
    })

    it('handles CRLF line endings', () => {
      expect(parseDockerfileForSingleFromRef('FROM alpine:3.22.4\r\n')).toBe('alpine:3.22.4')
    })

    it('is case-insensitive on FROM', () => {
      expect(parseDockerfileForSingleFromRef('from alpine:3.22.4\n')).toBe('alpine:3.22.4')
    })

    it('accepts registry-qualified refs with digest', () => {
      expect(parseDockerfileForSingleFromRef(`FROM ghcr.io/example/app@sha256:${SAMPLE_DIGEST}\n`)).toBe(
        `ghcr.io/example/app@sha256:${SAMPLE_DIGEST}`,
      )
    })

    it('accepts --platform flag', () => {
      expect(parseDockerfileForSingleFromRef('FROM --platform=linux/amd64 alpine:3.22.4\n')).toBe('alpine:3.22.4')
    })

    it('accepts AS <stage> suffix on a single stage', () => {
      expect(parseDockerfileForSingleFromRef('FROM alpine:3.22.4 AS base\n')).toBe('alpine:3.22.4')
    })

    it('strips Docker-style comments', () => {
      expect(parseDockerfileForSingleFromRef('# user-supplied image\nFROM alpine:3.22.4\n')).toBe('alpine:3.22.4')
    })

    it('strips blank lines around FROM', () => {
      expect(parseDockerfileForSingleFromRef('\n\nFROM alpine:3.22.4\n\n')).toBe('alpine:3.22.4')
    })

    it('handles leading whitespace before FROM', () => {
      expect(parseDockerfileForSingleFromRef('  FROM alpine:3.22.4\n')).toBe('alpine:3.22.4')
    })

    it('handles mixed leading + trailing whitespace and tabs', () => {
      expect(parseDockerfileForSingleFromRef('\t FROM alpine:3.22.4 \n')).toBe('alpine:3.22.4')
    })
  })

  describe('rejects multi-instruction dockerfiles', () => {
    it('rejects FROM + RUN', () => {
      expect(parseDockerfileForSingleFromRef('FROM alpine:3.22.4\nRUN apk add curl\n')).toBeNull()
    })

    it('rejects FROM + COPY', () => {
      expect(parseDockerfileForSingleFromRef('FROM alpine:3.22.4\nCOPY . /app\n')).toBeNull()
    })

    it('rejects ARG before FROM', () => {
      expect(parseDockerfileForSingleFromRef('ARG VERSION=3.22.4\nFROM alpine:${VERSION}\n')).toBeNull()
    })

    it('rejects multi-stage builds', () => {
      expect(
        parseDockerfileForSingleFromRef('FROM alpine:3.22.4 AS base\nFROM base\nRUN echo hi\n'),
      ).toBeNull()
    })
  })

  describe('rejects edge cases', () => {
    it('returns null on empty input', () => {
      expect(parseDockerfileForSingleFromRef('')).toBeNull()
      expect(parseDockerfileForSingleFromRef(undefined)).toBeNull()
      expect(parseDockerfileForSingleFromRef(null)).toBeNull()
    })

    it('returns null when FROM is missing', () => {
      expect(parseDockerfileForSingleFromRef('RUN echo hi\n')).toBeNull()
    })

    it('rejects build-arg interpolation in ref', () => {
      expect(parseDockerfileForSingleFromRef('FROM alpine:${VERSION}\n')).toBeNull()
    })

    it('rejects malformed FROM', () => {
      expect(parseDockerfileForSingleFromRef('FROM\n')).toBeNull()
      expect(parseDockerfileForSingleFromRef('FROM   \n')).toBeNull()
    })
  })
})
