/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import type { BoxCapabilities } from '../dto/box.dto'

export type BoxAdvancedOptionsInput = {
  privileged?: boolean
  capabilities?: Partial<BoxCapabilities>
}

export type NormalizedBoxAdvancedOptions = {
  privileged: boolean
  capabilities: BoxCapabilities
}

// Validate the portable spelling here, but leave kernel support checks to the
// guest. Linux can add capabilities independently of an API release.
const LINUX_CAPABILITY_NAME = /^[A-Z][A-Z0-9_]*$/

/** Return the canonical, unprefixed capability spelling used on the wire. */
export function canonicalizeLinuxCapability(value: string): string {
  const normalized = value.toUpperCase()
  const name = normalized.startsWith('CAP_') ? normalized.slice(4) : normalized

  if (!LINUX_CAPABILITY_NAME.test(name)) {
    throw new BadRequestError(`Malformed Linux capability '${value}'`)
  }

  return name
}

export function isValidLinuxCapabilityName(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }

  try {
    canonicalizeLinuxCapability(value)
    return true
  } catch {
    return false
  }
}

function normalizeCapabilityList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(canonicalizeLinuxCapability))]
}

/** Whether a policy is exactly the shape privileged mode expands to. */
function isPrivilegedCapabilityShape(capabilities: Partial<BoxCapabilities> | undefined): boolean {
  const add = capabilities?.add ?? []
  const drop = capabilities?.drop ?? []

  return drop.length === 0 && add.length === 1 && canonicalizeLinuxCapability(add[0]) === 'ALL'
}

/**
 * Expand the advanced-options contract without applying the request-time
 * conflict rule. Idempotent, so it is safe on an already-normalized value —
 * notably a row read back from storage, which is not a request and must not
 * be rejected like one.
 */
export function resolveBoxAdvancedOptions(input: BoxAdvancedOptionsInput = {}): NormalizedBoxAdvancedOptions {
  if (input.privileged) {
    return {
      privileged: true,
      capabilities: { add: ['ALL'], drop: [] },
    }
  }

  return {
    privileged: false,
    capabilities: {
      add: normalizeCapabilityList(input.capabilities?.add),
      drop: normalizeCapabilityList(input.capabilities?.drop),
    },
  }
}

/**
 * Validate and normalize the one public advanced-options contract, at a
 * request boundary. Privileged mode is a separate shape from capability
 * overrides and cannot be combined with them — except for the canonical
 * `add: ["ALL"]` policy privileged mode itself expands to. Every first-party
 * client serializes that policy alongside `privileged` (see
 * `CreateBoxRequest::from_options`), so rejecting it would reject every
 * privileged create the SDKs and CLI make. Mirrors the host-side carve-out in
 * `ContainerCapabilities::is_privileged_capability_shape`.
 */
export function normalizeBoxAdvancedOptions(input: BoxAdvancedOptionsInput = {}): NormalizedBoxAdvancedOptions {
  if (input.privileged !== undefined && typeof input.privileged !== 'boolean') {
    throw new BadRequestError('privileged must be a boolean')
  }

  if (input.privileged) {
    const hasOverrides = (input.capabilities?.add?.length ?? 0) > 0 || (input.capabilities?.drop?.length ?? 0) > 0

    if (hasOverrides && !isPrivilegedCapabilityShape(input.capabilities)) {
      throw new BadRequestError('privileged mode cannot be combined with cap_add or cap_drop')
    }
  }

  return resolveBoxAdvancedOptions(input)
}
