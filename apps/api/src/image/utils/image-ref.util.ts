/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import { supportedImages } from '../../box/constants/curated-images.constant'

/** Env var carrying the registry hosts a box image may be pulled from. */
const ALLOWLIST_ENV = 'BOXLITE_IMAGE_REGISTRY_ALLOWLIST'

/**
 * Registries a tenant-supplied image may name. Env-driven with a built-in
 * fallback, the same shape as the curated image set, so an operator can add a
 * registry without a deploy.
 *
 * `docker.io` and `ghcr.io` are deliberately absent, and their absence is
 * temporary. They are the two hosts the runner holds operator credentials for,
 * and credentials are runtime-scoped and matched by host, so until tenant pulls
 * are made anonymous a tenant ref on either one is fetched with the operator's
 * token. Widening this list is safe only once every runner carries that change
 * — and a deploy brings the API up before it upgrades the runners, so the two
 * cannot ride together.
 */
const FALLBACK_ALLOWLIST = ['quay.io', 'gcr.io', 'public.ecr.aws']

/** A registry ref is at most this long; anything beyond is a probe, not a name. */
const MAX_REF_LENGTH = 512

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
// Lowercase alphanumerics, separated by a single `.`, `_`, `__` or `-`. This is
// what rejects `..`, `../`, a leading separator, and an empty segment.
const PATH_SEGMENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/

export type ParsedImageRef = {
  /** Registry host, port included when the caller gave one. */
  host: string
  /** Path under the host, e.g. `library/python`. */
  repository: string
  tag?: string
  digest?: string
}

export function imageRegistryAllowlist(): string[] {
  const configured = (process.env[ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return configured.length > 0 ? configured : FALLBACK_ALLOWLIST
}

/** Whether the selector names a curated image, by short name or by full ref. */
export function isCuratedSelector(image: string | undefined): boolean {
  if (image === undefined) {
    return true
  }
  return supportedImages().some(({ name, ref }) => image === name || image === ref)
}

/**
 * Parse a tenant-supplied ref, rejecting anything malformed at the boundary.
 *
 * Everything downstream — the catalog key, the route parameter, the ref handed
 * to a runner — is built from these parts, so this is the one place that has to
 * be strict. A reader is not a validator: the patterns below are what stop
 * `../`, an empty segment, or an oversized probe from ever reaching them.
 */
export function parseImageRef(ref: string): ParsedImageRef {
  if (!ref || ref.trim() !== ref) {
    throw new BadRequestError('Image reference must be a non-empty string without surrounding whitespace')
  }
  if (ref.length > MAX_REF_LENGTH) {
    throw new BadRequestError(`Image reference exceeds ${MAX_REF_LENGTH} characters`)
  }

  let rest = ref
  let digest: string | undefined
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
    if (!DIGEST_PATTERN.test(digest)) {
      throw new BadRequestError(`Image digest '${digest}' must be sha256 followed by 64 hex characters`)
    }
  }

  let tag: string | undefined
  const lastColon = rest.lastIndexOf(':')
  if (lastColon !== -1 && !rest.slice(lastColon + 1).includes('/')) {
    tag = rest.slice(lastColon + 1)
    rest = rest.slice(0, lastColon)
    if (!TAG_PATTERN.test(tag)) {
      throw new BadRequestError(`Image tag '${tag}' is not a valid OCI tag`)
    }
  }

  const segments = rest.split('/')
  // A first segment carrying a dot, a port, or the literal `localhost` is a
  // registry host; otherwise the ref is a Docker Hub short form.
  const hasHost =
    segments.length > 1 && (segments[0].includes('.') || segments[0].includes(':') || segments[0] === 'localhost')
  const host = hasHost ? segments[0] : 'docker.io'
  const pathSegments = hasHost ? segments.slice(1) : segments
  const repository = pathSegments.length === 1 && !hasHost ? `library/${pathSegments[0]}` : pathSegments.join('/')

  if (pathSegments.length === 0 || pathSegments.some((segment) => !PATH_SEGMENT_PATTERN.test(segment))) {
    throw new BadRequestError(`Image repository '${rest}' is not a valid OCI repository path`)
  }

  return { host, repository, tag, digest }
}

/** Addresses that resolve inside the deployment rather than out to a registry. */
function isInternalAddress(host: string): boolean {
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return (
    hostname === 'localhost' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    hostname === '::1' ||
    /^fe80:/i.test(hostname) ||
    /^f[cd][0-9a-f]{2}:/i.test(hostname)
  )
}

/**
 * The allowlist is the gate, and it is the only one: a host on it is reachable,
 * a host off it is not, whatever the host looks like.
 *
 * Internal addresses are therefore not a second check — an earlier version
 * refused them separately, which changed nothing, because a host off the list
 * is already refused and a host on it was put there by an operator. What is
 * left is the part that does carry: a tenant who names the metadata endpoint
 * should be told that is why it was refused, rather than reading a registry
 * list and wondering which entry to copy. An operator who allowlists
 * `127.0.0.1:25000` for the local stack still gets it, because deciding what
 * this deployment may reach is the operator's job.
 */
export function assertHostIsAllowed(host: string, allowlist: string[]): void {
  if (allowlist.includes(host)) {
    return
  }
  if (isInternalAddress(host)) {
    throw new BadRequestError(`Image registry host '${host}' resolves inside the deployment and cannot be used`)
  }
  throw new BadRequestError(`Image registry '${host}' is not allowed. Allowed registries: ${allowlist.join(', ')}`)
}
