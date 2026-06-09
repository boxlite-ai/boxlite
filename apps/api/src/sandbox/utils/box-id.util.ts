/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomInt } from 'crypto'

export const BOX_ID_LENGTH = 12
export const BOX_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const BOX_ID_REGEX = /^[0-9A-Za-z]{12}$/

export function generateBoxId(): string {
  let boxId = ''
  for (let i = 0; i < BOX_ID_LENGTH; i += 1) {
    boxId += BOX_ID_ALPHABET[randomInt(BOX_ID_ALPHABET.length)]
  }
  return boxId
}

export function isBoxId(value: string): boolean {
  return BOX_ID_REGEX.test(value)
}
