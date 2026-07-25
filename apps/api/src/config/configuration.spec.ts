/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { isEnabledFlag } from './configuration'

describe('isEnabledFlag', () => {
  it('defaults to disabled when unset', () => {
    expect(isEnabledFlag(undefined)).toBe(false)
  })

  it('accepts common truthy spellings case- and whitespace-insensitively', () => {
    for (const value of ['1', 'true', 'True', 'TRUE', 'yes', 'on', '  on  ']) {
      expect(isEnabledFlag(value)).toBe(true)
    }
  })

  it('leaves anything else disabled, including garbage input', () => {
    for (const value of ['0', 'false', 'no', 'off', 'garbage', '']) {
      expect(isEnabledFlag(value)).toBe(false)
    }
  })
})
