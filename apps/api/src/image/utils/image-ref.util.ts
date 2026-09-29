/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import { supportedImages } from '../../box/constants/curated-images.constant'
import { registryProxyHost } from '../../registry/utils/registry-proxy.util'

/** Env var carrying the registry hosts a box image may be pulled from. */
const ALLOWLIST_ENV = 'BOXLITE_IMAGE_REGISTRY_ALLOWLIST'

/**
 * Registries a tenant-supplied image may name. Env-driven with a built-in
 * fallback, the same shape as the curated image set, so an operator can widen
 * or narrow it with no code change.
 *
 * `ghcr.io` is left out on purpose. A runner holds no registry credential: it
 * pulls a listed host anonymously, and a private image through the registry
 * proxy under its own key. One built before that change may still hold an
 * operator token for ghcr.io and apply it by host, so ghcr.io is added through
 * the env once every runner serves a build that holds none. No deployed runner
 * ever held Docker Hub credentials, so `docker.io` needs no wait.
 */
const FALLBACK_ALLOWLIST = ['docker.io', 'quay.io', 'gcr.io', 'public.ecr.aws']

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
 * The tag a bare repository names.
 *
 * Not a convenience: a registry resolves `acme/app` by fetching `acme/app:latest`,
 * so that is the tag a box booted from whether or not anyone typed it. It lives
 * here because the catalog has to record it and the resolver has to look it up,
 * and a rule those two spell differently is a reference that never pins.
 */
export const IMPLICIT_TAG = 'latest'

/** Whether a value is a sha256 digest, the only shape this system records. */
export function isSha256Digest(value: string): boolean {
  return DIGEST_PATTERN.test(value)
}

/** Whether a ref names an immutable build rather than a tag that can move. */
export function isDigestPinned(ref: string): boolean {
  const at = ref.lastIndexOf('@')
  return at > 0 && DIGEST_PATTERN.test(ref.slice(at + 1))
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
  // Docker Hub keeps its official images under `library/`, whether or not the
  // ref names the host, so `python` and `docker.io/python` are one catalog key.
  const repository =
    pathSegments.length === 1 && host === 'docker.io' ? `library/${pathSegments[0]}` : pathSegments.join('/')

  if (pathSegments.length === 0 || pathSegments.some((segment) => !PATH_SEGMENT_PATTERN.test(segment))) {
    throw new BadRequestError(`Image repository '${rest}' is not a valid OCI repository path`)
  }

  return { host, repository, tag, digest }
}

/**
 * The catalog key a reference normalises to, or undefined when it is not a
 * reference at all.
 *
 * The registrar writes rows under this name, the resolver looks them up by it,
 * the catalog answers `:idOrRef` with it, and the delete guard compares boxes
 * against it. Sharing one spelling is the point: a caller can name an image
 * three ways — `acme/app`, `acme/app:v1`, `acme/app@sha256:…` — and all three
 * have to reach the one row.
 *
 * Unlike {@link parseImageRef} this does not throw. Its callers are readers
 * asking "is this the same image", and a reference that no longer parses is
 * simply not the one being asked about. Rejecting malformed input stays with
 * the boundary.
 */
export function catalogNameOf(ref: string | undefined | null): string | undefined {
  if (!ref) {
    return undefined
  }
  try {
    const { host, repository } = parseImageRef(upstreamRefOf(ref))
    return `${host}/${repository}`
  } catch {
    return undefined
  }
}

/**
 * The ref a runner pulls a private image by: the registry proxy's host, then
 * the organization whose login the proxy presents, then the upstream host and
 * repository, e.g. `<proxy>/<org>/ghcr.io/acme/app:1.2`.
 *
 * Built from the parsed parts rather than the caller's string, so the three
 * ways to name one Docker Hub image — `alpine:3.20`, `docker.io/alpine:3.20`,
 * `library/alpine:3.20` — come out as one path.
 */
export function proxyRefOf(proxyHost: string, organizationId: string, parsed: ParsedImageRef): string {
  const reference = parsed.digest ? `@${parsed.digest}` : parsed.tag ? `:${parsed.tag}` : ''
  return `${proxyHost}/${organizationId}/${parsed.host}/${parsed.repository}${reference}`
}

/**
 * The upstream ref a proxy ref stands for, or the ref itself when it is not
 * one. A box records the proxy ref, because that is what its runner pulls; what
 * a tenant reads back, and what the catalog files the image under, is the
 * upstream name they asked for.
 */
export function upstreamRefOf(ref: string): string {
  const proxyHost = registryProxyHost()
  if (!proxyHost || !ref.startsWith(`${proxyHost}/`)) {
    return ref
  }
  // `<proxy>/<org>/<upstream…>`: drop the first two segments.
  const upstream = ref
    .slice(proxyHost.length + 1)
    .split('/')
    .slice(1)
    .join('/')
  return upstream || ref
}

/** The organization segment of a registry proxy ref: an organization id, a UUID. */
const PROXY_ORGANIZATION_SEGMENT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/**
 * `text` with the registry proxy's address taken out: {@link upstreamRefOf}
 * for prose rather than a single ref.
 *
 * A pull that fails through the proxy is reported in the runtime's words, and
 * those name what the runner was handed — `<proxy>/<org>/ghcr.io/acme/app:1`,
 * and in the registry client's request URL `https://<proxy>/v2/<org>/ghcr.io/…`.
 * The tenant named `ghcr.io/acme/app:1` and reads the proxy nowhere else, so
 * both become the upstream name. The URL form goes first, and the organization
 * is matched as the UUID it always is, so the URL's `v2` is never taken for one.
 *
 * What is left names the proxy alone, such as the `https://<proxy>/v2/` a
 * client asks for its challenge before any image, and fails by when the proxy
 * is unreachable. That fault is the proxy's, so it stays the proxy's: written
 * as the upstream it would blame ghcr.io for an outage it did not have.
 */
export function withoutRegistryProxy(text: string): string {
  const proxyHost = registryProxyHost()
  if (!proxyHost) {
    return text
  }
  const proxy = proxyHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(`${proxy}/v2/${PROXY_ORGANIZATION_SEGMENT}/([^/\\s]+)/`, 'g'), '$1/v2/')
    .replace(new RegExp(`${proxy}/${PROXY_ORGANIZATION_SEGMENT}/`, 'g'), '')
    .replace(new RegExp(`(?:https?://)?${proxy}(?:/[^\\s)'",]*)?`, 'g'), 'the registry proxy')
}

/**
 * Refuse a ref a tenant wrote against the registry proxy itself.
 *
 * Only the resolver produces those. One written by hand could name another
 * organization in its path and borrow that organization's login, and it is also
 * what keeps a runner's proxy key from being sent anywhere a tenant chose.
 */
export function assertNotThroughRegistryProxy(host: string): void {
  if (host === registryProxyHost()) {
    throw new BadRequestError(
      `Image registry '${host}' is the registry proxy; name the upstream image instead, and a registered credential routes it`,
    )
  }
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
 * The allowlist is the gate for a pull a runner makes directly: a host on it is
 * reachable, a host off it is not, whatever the host looks like. The one other
 * way in is a registered login, and that pull goes through the registry proxy
 * instead, for the four hosts a login is accepted for — see
 * `ImageAdmissionService`.
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
