/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator'

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

/**
 * Reject keys the capability policy does not define.
 *
 * The global validation pipe does not strip unknown properties, so a
 * misspelled security field would otherwise be accepted and ignored — the box
 * would start with the default capability set while the caller believes a
 * policy was applied.
 */
@ValidatorConstraint({ name: 'hasNoUnknownCapabilityFields', async: false })
export class HasNoUnknownCapabilityFieldsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'object' || value === null) {
      return true
    }
    // class-transformer materializes declared-but-absent keys as undefined, so
    // presence alone does not mean the caller sent them.
    const known = args.constraints[0] as string[]
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .every(([key]) => known.includes(key))
  }

  defaultMessage(args: ValidationArguments): string {
    const known = (args.constraints[0] as string[]).join(', ')
    return `${args.property} accepts only: ${known}`
  }
}
