// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export const PRODUCTION_STAGE = 'prod'

export const PORTS = {
  API: 3000,
  PROXY: 4000,
  RUNNER: 3003,
  JAEGER_UI: 16686,
  OTLP_HTTP: 4318,
  OTEL_HEALTH: 13133,
  MAILDEV_UI: 1080,
  PGADMIN: 80,
} as const

export const IMAGES = {
  jaeger: 'jaegertracing/all-in-one:1.67.0',
  pgadmin: 'dpage/pgadmin4:9.2.0',
  maildev: 'maildev/maildev:2.2.1',
} as const

export const RUNNER = {
  instanceType: 'c8i.2xlarge',
  rootDiskGB: 100,
  ubuntuOwnerId: '099720109477',
  ubuntuNamePattern: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
} as const

const HEALTH_DEFAULTS = {
  interval: '30 seconds',
  timeout: '5 seconds',
  healthyThreshold: 2,
  unhealthyThreshold: 3,
} as const

export function envOr(key: string, fallback: string): string
export function envOr<T>(key: string, fallback: T): string | T
export function envOr<T>(key: string, fallback: T): string | T {
  return process.env[key] || fallback
}

export const httpHealth = (path: string, overrides: Partial<{ successCodes: string }> = {}) => ({
  path,
  ...HEALTH_DEFAULTS,
  ...overrides,
})

export function requireEnv(key: string, why: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is required ${why}`)
  return value
}

export const runnerEndpoint = (override: string, port: number, scheme: string): string =>
  envOr(override, `${scheme}localhost:${port}`)
