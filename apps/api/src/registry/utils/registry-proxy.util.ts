/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** Env var naming the registry proxy's host, the one runners pull private images through. */
const REGISTRY_PROXY_HOST_ENV = 'REGISTRY_PROXY_HOST'

/**
 * Env var naming the registries a login may be registered for. The registry
 * proxy reads the same variable as the upstreams it will pull from, and the
 * stack writes it once for both: a host the API accepted a login for and the
 * proxy then refuses is a private pull that fails with a 403 nobody expected.
 */
const CREDENTIALED_HOSTS_ENV = 'REGISTRY_PROXY_UPSTREAM_HOSTS'

/**
 * The four that take a username and a token or password. `public.ecr.aws` holds
 * only public images, and Artifact Registry is left to keyless access, so
 * neither is here. The proxy's own default is the same list.
 */
const FALLBACK_CREDENTIALED_HOSTS = ['ghcr.io', 'docker.io', 'quay.io', 'gcr.io']

/** The registry proxy's host, or undefined when this deployment runs none. */
export function registryProxyHost(): string | undefined {
  return process.env[REGISTRY_PROXY_HOST_ENV]?.trim() || undefined
}

/** The registries a login may be registered for, and so reached through the proxy. */
export function credentialedRegistryHosts(): string[] {
  const configured = (process.env[CREDENTIALED_HOSTS_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return configured.length > 0 ? configured : FALLBACK_CREDENTIALED_HOSTS
}
