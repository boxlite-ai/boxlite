/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator'

export function isValidLinuxCapabilityName(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    [...value].some((character) => character.charCodeAt(0) > 0x7f)
  ) {
    return false
  }

  const normalized = value.toUpperCase()
  if (normalized === 'ALL') {
    return true
  }

  const name = normalized.startsWith('CAP_') ? normalized.slice(4) : normalized
  return /^[A-Z][A-Z0-9_]*$/.test(name)
}

@ValidatorConstraint({ name: 'isLinuxCapabilityName', async: false })
export class IsLinuxCapabilityNameConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidLinuxCapabilityName(value)
  }

  defaultMessage(): string {
    return 'each capability must be a Linux capability name or ALL'
  }
}
