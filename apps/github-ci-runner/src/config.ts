/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
export interface AppAuth {
  issuer: string
  privateKeyFile: string
  webhookSecretFile?: string
  accountType?: 'User' | 'Organization'
}
export type GitHubAuth =
  | ({ kind: 'app'; applications?: AppAuth[] } & AppAuth)
  | { kind: 'pat'; token: () => string; owner: string; repository: string }
export interface SelfConfig {
  endpoint: string
  apiKey: () => string
  github: GitHubAuth
  stateDir: string
  listen: { host: string; port: number }
  webhookSecretFile?: string
  allowPublic: boolean
  group: string
  worker: { image: string; cpus: number; memoryMiB: number; labels: string[] }
  max: number
}
export function privateFile(path: string): Buffer {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > 131072)
      throw new Error('Invalid private file')
    return readFileSync(fd)
  } catch {
    throw new Error('Secret file must be a readable regular file with private permissions')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SelfConfig {
  const endpoint = env.BOXLITE_REST_URL,
    apiKey = env.BOXLITE_API_KEY,
    issuer = env.CI_GITHUB_APP_CLIENT_ID,
    privateKeyFile = env.CI_GITHUB_APP_PRIVATE_KEY_FILE,
    token = env.GITHUB_TOKEN,
    configUrl = env.GITHUB_CONFIG_URL
  if (!endpoint || !apiKey) throw new Error('BOXLITE_REST_URL and BOXLITE_API_KEY are required')
  let github: GitHubAuth
  if (env.CI_GITHUB_APPS_FILE) {
    if (issuer || privateKeyFile || token || configUrl || env.CI_GITHUB_WEBHOOK_SECRET_FILE)
      throw new Error('Choose an Apps file or the single-App/token configuration')
    if (!isAbsolute(env.CI_GITHUB_APPS_FILE)) throw new Error('CI_GITHUB_APPS_FILE must be absolute')
    let raw: unknown
    try {
      raw = JSON.parse(privateFile(env.CI_GITHUB_APPS_FILE).toString('utf8'))
    } catch {
      throw new Error('Apps file must contain private, valid JSON')
    }
    if (!Array.isArray(raw) || !raw.length || raw.length > 8) throw new Error('Apps file requires 1–8 entries')
    const applications: AppAuth[] = raw.map((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) => !['client_id', 'private_key_file', 'webhook_secret_file', 'account_type'].includes(key),
        ) ||
        typeof value.client_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value.client_id) ||
        typeof value.private_key_file !== 'string' ||
        !isAbsolute(value.private_key_file) ||
        (value.webhook_secret_file !== undefined &&
          (typeof value.webhook_secret_file !== 'string' || !isAbsolute(value.webhook_secret_file))) ||
        (value.account_type !== undefined && !['User', 'Organization'].includes(value.account_type))
      )
        throw new Error('Invalid GitHub App entry')
      return {
        issuer: value.client_id,
        privateKeyFile: value.private_key_file,
        webhookSecretFile: value.webhook_secret_file,
        accountType: value.account_type,
      }
    })
    if (new Set(applications.map((app) => app.issuer)).size !== applications.length)
      throw new Error('Duplicate GitHub App identity')
    github = { kind: 'app', ...applications[0], applications }
  } else if (issuer || privateKeyFile) {
    if (!issuer || !privateKeyFile || token || configUrl)
      throw new Error('Choose App credentials or a single-repository GITHUB_TOKEN configuration')
    github = { kind: 'app', issuer, privateKeyFile }
  } else {
    if (!token || !configUrl)
      throw new Error('GitHub App credentials or GITHUB_TOKEN with GITHUB_CONFIG_URL are required')
    const url = new URL(configUrl),
      match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname)
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || !match)
      throw new Error('GITHUB_CONFIG_URL requires one GitHub.com repository')
    github = { kind: 'pat', token: () => token, owner: match[1], repository: match[2] }
  }
  const integer = (key: string, fallback: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key])
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(key + ' is out of range')
    return value
  }
  const memory = Number(env.CI_WORKER_MEMORY_GB ?? 2) * 1024
  if (!Number.isSafeInteger(memory) || memory < 128 || memory > 131072)
    throw new Error('CI_WORKER_MEMORY_GB must convert to whole MiB between 128 MiB and 128 GiB')
  const stateDir = env.CI_STATE_DIR ?? '/var/lib/boxlite-ci'
  if (!isAbsolute(stateDir)) throw new Error('CI_STATE_DIR must be absolute')
  const listenAddress = env.CI_LISTEN_ADDR ?? '0.0.0.0:8080'
  const port = /:(\d+)$/.exec(listenAddress)?.[1]
  const address = new URL('http://' + listenAddress)
  if (
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    address.pathname !== '/' ||
    !port ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new Error('CI_LISTEN_ADDR requires host:port')
  const allow = env.CI_ALLOW_PUBLIC_REPOSITORIES ?? 'false'
  if (!['true', 'false'].includes(allow)) throw new Error('CI_ALLOW_PUBLIC_REPOSITORIES must be true or false')
  if (env.CI_GITHUB_WEBHOOK_SECRET_FILE && github.kind !== 'app') throw new Error('Webhook requires GitHub App mode')
  return {
    endpoint,
    apiKey: () => apiKey,
    github,
    stateDir,
    listen: { host: address.hostname.replace(/^\[|\]$/g, ''), port: Number(port) },
    webhookSecretFile:
      github.kind === 'app' ? (github.webhookSecretFile ?? env.CI_GITHUB_WEBHOOK_SECRET_FILE) : undefined,
    allowPublic: allow === 'true',
    group: env.CI_WORKER_GROUP_NAME ?? 'boxlite-ci-runner',
    worker: {
      image: env.CI_WORKER_IMAGE ?? 'ghcr.io/actions/actions-runner:latest',
      cpus: integer('CI_WORKER_CPUS', 2, 16),
      memoryMiB: memory,
      labels: ['self-hosted', 'linux', 'x64', 'boxlite'],
    },
    max: integer('CI_WORKER_MAX', 1, 16),
  }
}
