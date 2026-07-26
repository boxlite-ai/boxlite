/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import {
  DEFAULT_LIST_PAGE_SIZE,
  MAX_LIST_PAGE_SIZE,
  resolveListPageSize,
  encodePageToken,
  decodePageToken,
} from './list-pagination.util'

describe('resolveListPageSize', () => {
  it('defaults when the param is absent or empty', () => {
    expect(resolveListPageSize(undefined)).toBe(DEFAULT_LIST_PAGE_SIZE)
    expect(resolveListPageSize('')).toBe(DEFAULT_LIST_PAGE_SIZE)
  })

  it('defaults on a non-integer value rather than serving an unbounded list', () => {
    expect(resolveListPageSize('abc')).toBe(DEFAULT_LIST_PAGE_SIZE)
    expect(resolveListPageSize('10.5')).toBe(DEFAULT_LIST_PAGE_SIZE)
  })

  it('clamps to the documented bounds', () => {
    expect(resolveListPageSize('0')).toBe(1)
    expect(resolveListPageSize('-5')).toBe(1)
    expect(resolveListPageSize('250')).toBe(250)
    expect(resolveListPageSize('99999')).toBe(MAX_LIST_PAGE_SIZE)
  })
})

describe('page token round-trip', () => {
  it('absent token resolves to page 1', () => {
    expect(decodePageToken(undefined)).toBe(1)
    expect(decodePageToken('')).toBe(1)
  })

  it('decodes what it encodes', () => {
    expect(decodePageToken(encodePageToken(2))).toBe(2)
    expect(decodePageToken(encodePageToken(57))).toBe(57)
  })

  it('matches the documented example token', () => {
    // openapi/box.openapi.yaml advertises eyJwYWdlIjoyfQ === {"page":2}
    expect(decodePageToken('eyJwYWdlIjoyfQ')).toBe(2)
  })

  it('rejects a malformed token instead of silently resetting to page 1', () => {
    expect(() => decodePageToken('not-base64-json!!')).toThrow(BadRequestException)
    expect(() => decodePageToken(encodePageToken(0))).toThrow(BadRequestException)
  })
})
