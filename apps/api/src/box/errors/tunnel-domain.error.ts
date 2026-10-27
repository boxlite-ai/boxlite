/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

export const DOMAIN_COUNT_LIMIT_CODE = 'domain_count_limit_reached'
export const SUBDOMAIN_TOO_SHORT_CODE = 'subdomain_too_short'
export const SUBDOMAIN_TAKEN_CODE = 'subdomain_taken'
export const REGION_NOT_SUPPORTED_CODE = 'region_not_supported'
export const PLATFORM_DOMAIN_NOT_CONFIGURED_CODE = 'platform_domain_not_configured'

/**
 * The organization already holds as many tunnel hostnames as it may.
 *
 * Unbinding a name does not free a slot: the name stays the organization's,
 * so the same name can be bound again without counting twice. The message says
 * so because the obvious remedy — unbind something — does not work.
 */
export class DomainCountLimitReachedError extends HttpException {
  constructor(limit: number, used: number) {
    super(
      {
        message:
          `This organization holds ${used} of its ${limit} tunnel domain names. ` +
          'Unbinding keeps a name for the organization, so reuse a held name or ask for a higher limit.',
        code: DOMAIN_COUNT_LIMIT_CODE,
      },
      HttpStatus.BAD_REQUEST,
    )
    this.name = 'DomainCountLimitReachedError'
  }
}

export class SubdomainTooShortError extends HttpException {
  constructor(subdomain: string, minLength: number) {
    super(
      {
        message: `Subdomain "${subdomain}" is too short: a new name needs at least ${minLength} characters.`,
        code: SUBDOMAIN_TOO_SHORT_CODE,
      },
      HttpStatus.BAD_REQUEST,
    )
    this.name = 'SubdomainTooShortError'
  }
}

/** Held by another organization, bound or not. */
export class SubdomainTakenError extends HttpException {
  constructor(hostname: string) {
    super({ message: `${hostname} is not available.`, code: SUBDOMAIN_TAKEN_CODE }, HttpStatus.CONFLICT)
    this.name = 'SubdomainTakenError'
  }
}

/**
 * The box lives in a region with its own proxy, which the platform domain's
 * wildcard record does not point at.
 */
export class RegionNotSupportedError extends HttpException {
  constructor(region: string) {
    super(
      {
        message: `Boxes in region ${region} are served by a regional proxy and cannot take a platform subdomain.`,
        code: REGION_NOT_SUPPORTED_CODE,
      },
      HttpStatus.BAD_REQUEST,
    )
    this.name = 'RegionNotSupportedError'
  }
}

export class PlatformDomainNotConfiguredError extends HttpException {
  constructor() {
    super(
      {
        message: 'This deployment has no platform tunnel domain; subdomains cannot be bound.',
        code: PLATFORM_DOMAIN_NOT_CONFIGURED_CODE,
      },
      HttpStatus.BAD_REQUEST,
    )
    this.name = 'PlatformDomainNotConfiguredError'
  }
}
