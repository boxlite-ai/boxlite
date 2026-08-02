// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { config as loadDotenv } from 'dotenv'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { optionalPublicOidcIssuer, requireOidcIssuer } from './oidc-issuer.mjs'

const DEFAULT_AWS_REGION = 'ap-southeast-1'
const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const DEFAULT_MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))

export function loadDeploymentEnvironment({ path, environment = process.env } = {}) {
  return loadDotenv({
    ...(path ? { path } : {}),
    processEnv: environment,
    quiet: true,
  })
}

export function resolveAwsRegion(environment = process.env) {
  return environment.AWS_REGION?.trim() || DEFAULT_AWS_REGION
}

export function resolveReleaseVersion(workspaceVersion, environment = process.env) {
  if (typeof workspaceVersion !== 'string' || workspaceVersion.trim() === '') {
    throw new Error('The workspace release version is missing')
  }
  if (workspaceVersion !== workspaceVersion.trim() || !STABLE_SEMVER_PATTERN.test(workspaceVersion)) {
    throw new Error(
      `The workspace release version '${workspaceVersion}' is not a stable semantic version (expected X.Y.Z)`,
    )
  }

  const configuredVersion = environment.VERSION
  if (configuredVersion === undefined || configuredVersion === '') return workspaceVersion
  if (configuredVersion !== configuredVersion.trim() || !STABLE_SEMVER_PATTERN.test(configuredVersion)) {
    throw new Error(`VERSION '${configuredVersion}' is not a stable semantic version (expected X.Y.Z)`)
  }
  return configuredVersion
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function findRepositoryRoot(moduleDirectory) {
  if (typeof moduleDirectory !== 'string' || moduleDirectory === '') {
    throw new Error('moduleDirectory must be a non-empty filesystem path')
  }

  const startingDirectory = resolve(moduleDirectory)
  let candidateDirectory = startingDirectory

  while (true) {
    const cargoTomlPath = join(candidateDirectory, 'Cargo.toml')
    const infraPackagePath = join(candidateDirectory, 'apps', 'infra', 'package.json')
    if (isFile(cargoTomlPath) && isFile(infraPackagePath)) return candidateDirectory

    const parentDirectory = dirname(candidateDirectory)
    if (parentDirectory === candidateDirectory) break
    candidateDirectory = parentDirectory
  }

  throw new Error(
    `could not find the BoxLite repository root from '${startingDirectory}' ` +
      '(expected one ancestor containing both Cargo.toml and apps/infra/package.json)',
  )
}

export function readWorkspaceVersion({ moduleDirectory = DEFAULT_MODULE_DIRECTORY } = {}) {
  const repositoryRoot = findRepositoryRoot(moduleDirectory)
  const cargoTomlPath = join(repositoryRoot, 'Cargo.toml')
  let cargoToml
  try {
    cargoToml = readFileSync(cargoTomlPath, 'utf8')
  } catch (cause) {
    throw new Error(`could not read workspace release version from '${cargoTomlPath}'`, { cause })
  }
  const version = cargoToml.match(/^version\s*=\s*"(.+?)"/m)?.[1]
  if (!version) {
    throw new Error(
      `could not parse release version from '${cargoTomlPath}' (expected a top-level \`version = "X.Y.Z"\`)`,
    )
  }
  return version
}

function requireHostname(name, value) {
  if (!value || value !== value.trim()) {
    throw new Error(`${name} must be a hostname without whitespace`)
  }

  let url
  try {
    url = new URL(`https://${value}`)
  } catch {
    throw new Error(`${name} must be a valid hostname`)
  }
  if (
    url.hostname !== value.toLowerCase() ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a hostname without a scheme, port, path, credentials, query, or fragment`)
  }
  return url.hostname
}

/*
 * Reject a malformed entry here, where it costs nothing, rather than after SST
 * has begun mutating the stack.
 *
 * The parsed images are deliberately not returned. A post-deploy check compared
 * them to /api/config, which carries no image list yet: that field is the
 * acceptance criterion for #1045, and the check landed ahead of the API work it
 * tests, so every apply that set this variable failed (#1119). Reinstate the
 * comparison together with #1045, not before.
 */
function validateConfiguredSystemImages(rawImages) {
  for (const entry of (rawImages ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf('=')
    const name = separator > 0 ? entry.slice(0, separator).trim() : ''
    const ref = separator > 0 ? entry.slice(separator + 1).trim() : ''
    if (!name || !ref) {
      throw new Error(`Invalid BOXLITE_SYSTEM_IMAGES entry '${entry}', expected 'name=ref'`)
    }
  }
}

export function resolvePublicDeploymentConfig(environment = process.env, workspaceVersion = readWorkspaceVersion()) {
  const stackDomain = requireHostname('STACK_DOMAIN', environment.STACK_DOMAIN)

  const proxyDomain = requireHostname('PROXY_DOMAIN', environment.PROXY_DOMAIN?.trim() || `proxy.${stackDomain}`)
  const proxyProtocol = environment.PROXY_PROTOCOL?.trim() || 'https'
  if (proxyProtocol !== 'https') {
    throw new Error(`PROXY_PROTOCOL must be https for the provisioned TLS NLB, received ${proxyProtocol}`)
  }
  const expectedProxyTemplateUrl = environment.PROXY_TEMPLATE_URL?.trim() || `${proxyProtocol}://${proxyDomain}`
  let proxyTemplateUrl
  try {
    proxyTemplateUrl = new URL(expectedProxyTemplateUrl)
  } catch {
    throw new Error('PROXY_TEMPLATE_URL must be a valid absolute HTTPS URL')
  }
  if (
    proxyTemplateUrl.protocol !== 'https:' ||
    proxyTemplateUrl.username ||
    proxyTemplateUrl.password ||
    proxyTemplateUrl.port ||
    proxyTemplateUrl.pathname !== '/' ||
    proxyTemplateUrl.search ||
    proxyTemplateUrl.hash
  ) {
    throw new Error('PROXY_TEMPLATE_URL must be an HTTPS origin without credentials, port, path, query, or fragment')
  }
  if (proxyTemplateUrl.hostname !== proxyDomain) {
    throw new Error(`PROXY_TEMPLATE_URL host ${proxyTemplateUrl.hostname} does not match PROXY_DOMAIN ${proxyDomain}`)
  }
  const expectedOidcIssuer = optionalPublicOidcIssuer(environment) ?? requireOidcIssuer(environment)
  const proxyTemplateOrigin = proxyTemplateUrl.origin
  const releaseVersion = resolveReleaseVersion(workspaceVersion, environment)
  validateConfiguredSystemImages(environment.BOXLITE_SYSTEM_IMAGES)

  return {
    stackDomain,
    proxyDomain,
    proxyProtocol,
    proxyTemplateUrl: proxyTemplateOrigin,
    releaseVersion,
    proxyHealthUrl: `${proxyProtocol}://${proxyDomain}/health`,
    proxyWildcardHealthUrl: `${proxyProtocol}://deployment-probe.${proxyDomain}/health`,
    apiConfigUrl: `https://api.${stackDomain}/api/config`,
    expectedOidcIssuer,
    expectedProxyTemplateUrl: proxyTemplateOrigin,
    expectedVersion: releaseVersion,
  }
}
